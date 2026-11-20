// Exercise the same CSV builder as the demo with one saved product and live
// eBay category metadata. Read-only APIs; no product edits or listing uploads.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../public/core.js';
import { sellerExportConfig } from '../public/export-settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const productId = process.argv[2] ?? 'p_e9465c32c507f49f';
const categoryId = process.argv[3] ?? '112581';
if (!/^[a-z0-9_-]+$/i.test(productId) || !/^\d+$/.test(categoryId)) throw new Error('Invalid product/category identifier');
async function get(route) {
  const response = await fetch(`http://127.0.0.1:8787${route}`, { signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Local API ${response.status}: ${data.error ?? 'request_failed'}`);
  return data;
}
const [saved, settings, taxonomy] = await Promise.all([get('/api/products'), get('/api/config'), get(`/api/ebay/categories/${categoryId}`)]);
const product = (saved.products ?? saved).find((item) => item.id === productId);
if (!product) throw new Error('Saved product not found');
const category = taxonomy.category;
const config = sellerExportConfig(settings.config ?? settings);
const template = Core.parseEbayTemplate(await readFile(path.join(root, 'public/templates/ebay-20563.csv'), 'utf8'));
const groups = [{ key: 'sample', label: category.categoryName, categoryId, resolvedCategory: category, products: [product] }];
const { files, skipped } = Core.buildGroupedEbayCsvs([product], template, config, groups);
if (!files[0]) throw new Error(skipped.map((item) => item.reason).join('; ') || 'No CSV generated');
const file = files[0];
const rows = Core.parseCsvText(file.csv);
const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
const data = rows.filter((row) => row[Core.templateColumnIndex(headers, 'Action')] === 'Add');
const fields = headers.map((column, index) => ({ column, value: data[0]?.[index] ?? '' }));
const sourceIssues = file.validationIssues.filter((issue) => !/seller_setting|policy_name/.test(issue.code));
const sellerFields = [...new Set(file.validationIssues.filter((issue) => /seller_setting|policy_name/.test(issue.code)).map((issue) => issue.field))];
const aspects = [...category.requiredAspects, ...category.recommendedAspects];
const fieldMap = aspects.map((aspect) => {
  const column = `C:${aspect.name}`;
  const value = data[0]?.[Core.templateColumnIndex(headers, column)] ?? '';
  return { column, required: category.requiredAspects.some((item) => item.name === aspect.name), value, status: value ? 'filled' : 'missing' };
});
const mappedSpecColumns = {
  Dimensions: ['Item Height', 'Item Width', 'Item Length'], Weight: ['Item Weight'],
  Dimmable: ['Features'], 'Bulb style': ['Lighting Technology'], 'Lighting Certification US': ['Labels & Certifications'],
};
const sourceSpecMap = Object.entries(product.specs ?? {}).map(([name, value]) => {
  const candidates = mappedSpecColumns[name] ?? [name];
  const mapped = fieldMap.filter((field) => field.value && candidates.some((candidate) => field.column.toLowerCase() === `c:${candidate.toLowerCase()}`));
  return { name, value, columns: mapped.map((field) => field.column) };
});
const sourceFindings = [];
if (/\bDiscontinued\b|\bno longer available\b/i.test(product.description ?? '')) sourceFindings.push('Mô tả đã lưu có thông báo ngừng bán/hết hàng. Đây là file kiểm tra dữ liệu; cần xác minh lại tồn kho nguồn trước khi dùng để listing.');
if (/\bDownload tearsheet\s*$/i.test(product.description ?? '')) sourceFindings.push('Mô tả đã lưu còn chữ nút Download tearsheet; cần crawl lại sau bản sửa reader.');
for (const [label, value] of Object.entries(product.specs ?? {})) {
  if (/\b(?:Assembled size|Base dimensions|Lighting Certification US)\s*:/i.test(String(value))) {
    sourceFindings.push(`Thông số ${label} trong dữ liệu đã lưu còn ghép nhãn kế tiếp; cần crawl lại sau bản sửa reader.`);
  }
}
const outputDir = path.join(root, 'exports');
await mkdir(outputDir, { recursive: true });
const filename = `sample-${productId}-${categoryId}.csv`;
const stem = filename.replace(/\.csv$/, '');
await writeFile(path.join(outputDir, filename), file.csv, 'utf8');
const report = {
  generatedAt: new Date().toISOString(), productId, productVersion: product.version, title: product.title,
  sourceUrl: product.source_url ?? product.url, sourcePrice: product.price, sourceCurrency: product.currency,
  categoryId, categoryName: category.categoryName, verifiedFromEbay: category.verifiedFromEbay,
  filename, rows: data.length, columns: headers.length, requiredFields: category.requiredAspects.map((item) => item.name),
  fieldMap, sourceSpecMap, populatedColumns: fields.filter((field) => field.value), sourceIssues, sourceFindings, sellerFields,
  originalImageCount: (product.images ?? []).length,
  caveat: 'Uses saved crawl data and the tool CSV builder. No new live page crawl or Seller Hub upload performed.',
};
await writeFile(path.join(outputDir, `${stem}-report.json`), JSON.stringify(report, null, 2), 'utf8');
await writeFile(path.join(outputDir, `${stem}-category.json`), JSON.stringify(category), 'utf8');
const cell = (name) => data[0]?.[Core.templateColumnIndex(headers, name)] ?? '';
const escapeMd = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const reportText = [
  `# Kiểm tra xuất CSV: ${product.title}`, '',
  `Nguồn: ${product.source_url ?? product.url}`, '',
  `Dùng bản crawl đã lưu (version ${product.version}), tra trực tiếp Category ID **${categoryId} — ${category.categoryName}** qua API eBay. CSV được tạo bằng chính buildGroupedEbayCsvs của tool. Không sửa dữ liệu đã lưu, không đăng listing.`, '',
  `File: ${filename}. ${data.length} dòng sản phẩm, ${headers.length} cột.`, '',
  `Điền được ${fieldMap.filter((field) => field.value).length}/${fieldMap.length} trường sản phẩm của danh mục; ${fieldMap.filter((field) => field.required && field.value).length}/${fieldMap.filter((field) => field.required).length} trường bắt buộc có dữ liệu. Những trường không có căn cứ được để trống.`, '',
  `Giá nguồn: ${product.price} ${product.currency}. StartPrice trong CSV: ${cell('StartPrice') || '(trống — chưa đủ giá bán/tỷ giá để tính)'} (quy tắc tính giá hiện có của tool, không phải giá nguồn). Quantity=${cell('Quantity')} và ConditionID=${cell('ConditionID')} là mặc định của bộ xuất, không phải số lượng tồn kho/tình trạng được xác minh lại từ nguồn.`, '',
  `Ảnh: ${cell('PicURL').split('|').filter(Boolean).length} URL trong CSV.`, '',
  '## Trường sản phẩm từ eBay', '',
  '| Cột CSV | eBay bắt buộc | Giá trị xuất |', '| --- | --- | --- |',
  ...fieldMap.map((field) => `| ${escapeMd(field.column)} | ${field.required ? 'Có' : 'Không'} | ${escapeMd(field.value || '(trống)')} |`), '',
  '## Đối chiếu thông số nguồn đã lưu', '',
  'Các thông số không có cột tương ứng trong danh mục hoặc chưa có quy tắc ánh xạ vẫn được giữ trong dữ liệu nguồn; không tự thêm cột sai danh mục vào CSV.', '',
  '| Nhãn nguồn | Giá trị đã crawl | Cột CSV được điền |', '| --- | --- | --- |',
  ...sourceSpecMap.map((item) => `| ${escapeMd(item.name)} | ${escapeMd(item.value)} | ${escapeMd(item.columns.join(', ') || 'Chưa ánh xạ vào trường danh mục')} |`), '',
  '## Kết quả đối chiếu', '',
  ...(sourceIssues.length ? sourceIssues.map((issue) => `- ${issue.field}: ${issue.message}`) : ['- Các kiểm tra trường sản phẩm bắt buộc của tool đều đạt. Đây chưa phải xác nhận mọi trường nguồn đã được đọc đầy đủ.']),
  ...sourceFindings.map((finding) => `- ${finding}`),
  `- Thông tin shop để seller điền sau: ${sellerFields.join(', ')}.`,
  '- Chưa upload thử Seller Hub. Không lấy dữ liệu còn thiếu từ một listing eBay khác để gán sang sản phẩm này.', '',
].join('\n');
await writeFile(path.join(outputDir, `${stem}-check.md`), reportText, 'utf8');
console.log(JSON.stringify({ filename, title: product.title, categoryId, categoryName: category.categoryName,
  rows: data.length, columns: headers.length, bytes: Buffer.byteLength(file.csv), sourceIssues,
  sellerFields, fieldsFilled: fieldMap.filter((field) => field.value).length, fieldsAvailable: fieldMap.length,
  values: fields.filter((field) => field.value && !['PicURL', 'Description'].includes(field.column.replace(/^\*/, ''))) }, null, 2));
