import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseSohoDetailsText,
  materialPhraseFromDescription,
  ruleBasedExtractPage,
  normalizeAiExtractedPage,
  extractPageWithRuntime,
  extractPageRecord,
} from '../server/ai.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';
import {
  normalizeRecord,
  parseEbayTemplate,
  parseCsvText,
  templateColumnIndex,
  groupProductsByTheme,
  buildGroupedEbayCsvs,
  applyTaxonomyResolutions,
  calcSellPrice,
  crawledSummaryItems,
} from '../public/core.js';
import {
  FLEUR_URL,
  FLEUR_LISTING_IMAGE,
  FLEUR_TITLE,
  FLEUR_PRICE,
  FLEUR_COMPARE_AT,
  FLEUR_MATERIAL_PHRASE,
  FLEUR_DESCRIPTION,
  FLEUR_PAGE_TEXT,
  makeFleurRawA,
  makeFleurRawB,
} from './fixtures/fleur-table-lamp-raw.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const template = parseEbayTemplate(readFileSync(path.join(repo, 'public/templates/ebay-20563.csv'), 'utf8'));
// Cấu hình như test taxonomy v9.4: markup 0 → StartPrice = giá gốc 315.00.
const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };
const TYPE_VALUES_19591 = ['Table Lamp', 'Floor Lamp', 'Chandelier', 'Wall Light', 'Ceiling Light', 'Pendant Light'];

// Lấy dòng sản phẩm đầu tiên trong CSV file Exchange (dòng sau Info).
function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { headers: rows[1], row: rows[firstDataIdx] };
}

function assertFleurFields(extracted, label) {
  assert.equal(extracted.price, FLEUR_PRICE, `${label}: giá = 315 (non-member, không phải member 252)`);
  assert.equal(extracted.currency, 'USD', `${label}: currency USD`);
  assert.ok((extracted.description ?? '').length > 50, `${label}: mô tả không trống`);
  assert.match(extracted.description, /mushroom/i, `${label}: mô tả có nội dung đèn nấm`);
  assert.equal(extracted.images?.[0], FLEUR_LISTING_IMAGE, `${label}: ảnh đầu = ảnh listing chính`);
  assert.equal(extracted.material, FLEUR_MATERIAL_PHRASE, `${label}: chất liệu từ câu mô tả`);
  assert.match(extracted.dimensions ?? '', /H49/, `${label}: kích thước có H49cm`);
  assert.equal(extracted.specs?.['Bulb type'], 'E26', `${label}: bóng E26`);
  assert.equal(extracted.specs?.['Wattage'], '60W', `${label}: công suất 60W`);
  assert.match(extracted.specs?.['Care instructions'] ?? '', /dry cloth/i, `${label}: care lau khăn khô`);
  assert.equal(extracted.specs?.['Switch'], 'In-line on/off switch', `${label}: công tắc trên dây`);
  assert.equal(extracted.variants?.[0]?.price, FLEUR_PRICE, `${label}: variant giữ giá 315`);
  assert.equal(extracted.variants?.[0]?.sku ?? null, null, `${label}: không bịa SKU`);
}

// ---- Đào panel "Details & Dimensions" từ text phẳng -----------------------

test('v9.5 parseSohoDetailsText: đào đúng mô tả + specs đèn từ pageText (không cắt ở từ "shade" trong câu)', () => {
  const { description, specs } = parseSohoDetailsText(FLEUR_PAGE_TEXT);
  assert.ok(description.length > 50, 'mô tả không trống');
  assert.match(description, /half-sphere shade on a cylindrical stem/, 'mô tả KHÔNG bị cắt ở từ "shade" trong câu');
  assert.match(description, /Milky-white glass/, 'mô tả giữ tới câu chất liệu');
  assert.equal(specs.Dimensions, 'H19.3 x W13.4 x D13.4" / H49 x W34 x D34cm');
  assert.equal(specs.Shade, 'H6.7 x W13.4 x D13.4" / H17 x W34 x D34cm');
  assert.equal(specs.Base, 'H12.6 x W5.9 x D5.9" / H32 x W15 x D15cm');
  assert.equal(specs.Weight, '13.7 lbs / 6.2 kg');
  assert.equal(specs['Bulb type'], 'E26');
  assert.equal(specs['Number of bulbs'], '1');
  assert.equal(specs['Bulb included'], 'No');
  assert.equal(specs.Wattage, '60W');
  assert.equal(specs['Light source'], 'LED');
  assert.equal(specs.Dimmable, 'No');
  assert.equal(specs.Switch, 'In-line on/off switch', 'từ "switch" lặp trong giá trị được gộp, không cắt');
  assert.equal(specs['Cable length'], '98.4" / 250cm');
  assert.equal(specs['Cable colour'], 'Black');
  assert.equal(specs.Voltage, '110-120V');
  assert.match(specs['Care instructions'], /dry cloth/i);
  assert.ok(!JSON.stringify(specs).includes('Delivery from'), 'specs không lẫn nội dung Delivery');
});

test('v9.5 parseSohoDetailsText: không có panel thì trả mô tả/specs trống (không bịa)', () => {
  const out = parseSohoDetailsText('Fleur Table Lamp Price $315 Delivery from 4 days');
  assert.equal(out.description, null);
  assert.deepEqual(out.specs, {});
});

test('v9.5 materialPhraseFromDescription: lấy cụm chất liệu từ câu mô tả, không có thì null', () => {
  assert.equal(materialPhraseFromDescription(FLEUR_DESCRIPTION), FLEUR_MATERIAL_PHRASE);
  assert.equal(materialPhraseFromDescription('A beautiful lamp for your living room. It looks great on a side table.'), null);
  assert.equal(materialPhraseFromDescription('Made from solid oak and brass, this table stands 80cm tall.'), 'Solid oak and brass');
});

// ---- Trích xuất rule-based (KHÔNG cần key AI) -----------------------------

test('v9.5 ruleBasedExtractPage: payload kiểu v1.3.1 (price top-level null, giá chỉ ở variant) vẫn ra đủ giá/mô tả/ảnh/specs, không cảnh báo sai', () => {
  const { extracted, warnings } = ruleBasedExtractPage(makeFleurRawA());
  assertFleurFields(extracted, 'Raw A');
  assert.deepEqual(warnings, [], 'không cảnh báo "trang không ghi giá" khi giá ở variant');
});

test('v9.5 ruleBasedExtractPage: chỉ còn pageText (reader bỏ lỡ mô tả/specs) vẫn đào đủ từ panel', () => {
  const { extracted, warnings } = ruleBasedExtractPage(makeFleurRawB());
  assertFleurFields(extracted, 'Raw B');
  assert.deepEqual(warnings, [], 'không cảnh báo sai khi đào được từ pageText');
});

test('v9.5 ruleBasedExtractPage: trang thật sự không có giá thì báo đúng, không bịa giá', () => {
  const raw = makeFleurRawB();
  raw.variants = [{ options: {}, price: null, in_stock: true }];
  raw.pageText = raw.pageText.replace(/Price \$315\n/, '');
  const { extracted, warnings } = ruleBasedExtractPage(raw);
  assert.equal(extracted.price, null);
  assert.ok(warnings.some((w) => /không ghi giá/i.test(w)), 'có cảnh báo trang không ghi giá');
});

// ---- Logic giá: LLM chỉ được giữ khi khớp giá trang -----------------------

test('v9.5 normalizeAiExtractedPage: giá LLM khớp 1 biến thể thì được giữ (trước đây bị loại là "bịa")', () => {
  const { extracted, warnings } = normalizeAiExtractedPage({ price: 315, title: FLEUR_TITLE }, makeFleurRawA());
  assert.equal(extracted.price, 315);
  assert.deepEqual(warnings, []);
});

test('v9.5 normalizeAiExtractedPage: giá LLM lệch mọi giá trên trang thì dùng giá trang + cảnh báo', () => {
  const { extracted, warnings } = normalizeAiExtractedPage({ price: 999, title: FLEUR_TITLE }, makeFleurRawA());
  assert.equal(extracted.price, 315, 'dùng giá trang 315, không dùng 999 của LLM');
  assert.ok(warnings.some((w) => /không khớp giá trên trang gốc/i.test(w)));
});

test('v9.5 normalizeAiExtractedPage: trang không có giá mà LLM đưa giá thì loại + cảnh báo (không bịa)', () => {
  const raw = makeFleurRawB();
  raw.variants = [{ options: {}, price: null, in_stock: true }];
  raw.pageText = raw.pageText.replace(/Price \$315\n/, '');
  const { extracted, warnings } = normalizeAiExtractedPage({ price: 999, title: FLEUR_TITLE }, raw);
  assert.equal(extracted.price, null);
  assert.ok(warnings.some((w) => /trang không ghi giá/i.test(w)));
});

test('v9.5 normalizeAiExtractedPage: LLM không trả variants thì dùng variants của reader (không mất giá)', () => {
  const { extracted } = normalizeAiExtractedPage({ price: null, title: FLEUR_TITLE, variants: [] }, makeFleurRawA());
  assert.equal(extracted.price, 315);
  assert.equal(extracted.variants[0].price, 315);
});

// ---- End-to-end: POST /api/ai/extract-page không cần key AI --------------

test('v9.5 POST /api/ai/extract-page: không key AI vẫn lưu được sản phẩm Fleur đủ giá/mô tả/ảnh, SKU trống', async () => {
  const store = new MemoryStore();
  const { status, json } = await handleRequest(store, {
    method: 'POST',
    path: '/api/ai/extract-page',
    body: { url: FLEUR_URL, sourceSite: 'sohohome.com', sourceProductId: 'fleur-table-lamp', raw: makeFleurRawA() },
  }, { aiRuntime: null });
  assert.equal(status, 200);
  assert.equal(json.provider, 'rule-based', 'không có key thì dùng rule-based, không lỗi');
  const p = json.product;
  assert.ok(p, 'trả về product đã lưu');
  assert.equal(p.title, FLEUR_TITLE);
  assert.equal(p.price, FLEUR_PRICE);
  assert.ok((p.description ?? '').length > 50, 'mô tả đã lưu');
  assert.equal(p.images[0], FLEUR_LISTING_IMAGE, 'ảnh đầu = ảnh listing chính');
  assert.equal(p.specs['Bulb type'], 'E26');
  assert.match(p.specs['Care instructions'], /dry cloth/i);
  assert.equal(p.variants[0].sku ?? null, null, 'không bịa SKU');
  assert.ok(!JSON.stringify(p).includes('79971888') || p.images.some((u) => u.includes('79971888')), 'số 79971888 chỉ được phép xuất hiện trong tên file ảnh');
  assert.ok(!(json.warnings ?? []).some((w) => /không ghi giá/i.test(w)), 'không cảnh báo sai về giá');
  const stored = await store.getProduct(p.id);
  assert.ok(stored, 'sản phẩm đã lưu trong store');
});

// ---- End-to-end: CSV 19591 từ dữ liệu Fleur thật --------------------------

function makeFleurProduct() {
  const raw = makeFleurRawA();
  const { extracted } = ruleBasedExtractPage(raw);
  const record = extractPageRecord(raw, extracted);
  const { product } = normalizeRecord(record);
  return product;
}

test('v9.5 CSV 19591: StartPrice 315.00, Type Table Lamp, Description/PicURL/Bulb Type/Material/Size/Care đủ', () => {
  const product = makeFleurProduct();
  assert.equal(product.price, FLEUR_PRICE);
  assert.equal(product.variants[0].compare_at_price, FLEUR_COMPARE_AT, 'giữ được giá gốc 450 làm compare-at');
  assert.equal(product.specs['Bulb type'], 'E26');

  const products = [product];
  const groups = groupProductsByTheme(products);
  const applied = applyTaxonomyResolutions(products, groups, [{
    groupKey: 'lighting',
    categoryId: '19591',
    categoryName: 'Lighting Kits',
    categoryPath: 'Home & Garden > Lamps > Lighting Kits',
    requiredAspects: [
      { name: 'Type', values: TYPE_VALUES_19591 },
      { name: 'Brand', values: [] },
    ],
    recommendedAspects: [
      { name: 'Bulb Type', values: ['E26', 'E27', 'B22', 'GU10'] },
      { name: 'Material', values: ['Metal', 'Glass', 'Wood', 'Ceramic'] },
      // Simulated category schema must explicitly include these fields;
      // resolved exports no longer inherit unrelated aspects from a pillow.
      { name: 'Item Height', values: [] },
      { name: 'Care Instructions', values: [] },
    ],
  }]);
  assert.deepEqual(applied, { appliedGroups: 1, appliedProducts: 1 });
  const { files } = buildGroupedEbayCsvs(products, template, config, groups);
  const lampFile = files.find((f) => f.groupKey === 'lighting');
  assert.ok(lampFile, 'nhóm đèn 19591 phải có file upload được');
  assert.equal(lampFile.filename, 'ebay-19591-lighting.csv');
  assert.equal(lampFile.categoryId, '19591');
  const { headers, row } = firstDataRow(lampFile.csv);
  const col = (name) => row[templateColumnIndex(headers, name)];
  assert.equal(col('Category'), '19591');
  assert.equal(col('C:Type'), 'Table Lamp', 'Type khớp từ danh sách của danh mục 19591');
  assert.equal(col('StartPrice'), calcSellPrice(FLEUR_PRICE, config).toFixed(2));
  assert.equal(col('StartPrice'), '315.00');
  assert.ok((col('Description') ?? '').length > 50, 'Description không trống');
  assert.ok(col('PicURL').startsWith(FLEUR_LISTING_IMAGE), 'PicURL bắt đầu bằng ảnh listing chính');
  assert.match(col('C:Material') ?? '', /glass/i, 'C:Material lấy từ cụm chất liệu của trang');
  assert.match(col('C:Item Height') ?? '', /19\.3/, 'C:Item Height từ kích thước inch');
  assert.match(col('C:Care Instructions') ?? '', /dry cloth/i, 'C:Care Instructions từ panel');
  assert.equal(col('C:Bulb Type'), 'E26', 'C:Bulb Type từ specs (cột thêm ngoài 98 cột template gối)');
  assert.ok(!/79971888/.test(col('CustomLabel') ?? ''), 'CustomLabel không chứa số tên file ảnh');
});

// ---- Danh sách "Đã cào được": thêm Bóng đèn + Chăm sóc -------------------

test('v9.5 crawledSummaryItems: Fleur có dòng "Bóng đèn" E26 — 60W và "Chăm sóc" lau khăn khô', () => {
  const product = makeFleurProduct();
  const items = crawledSummaryItems(product, { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0 });
  assert.equal(items.length, 13, 'danh sách "Đã cào được" giờ 13 dòng (thêm 2)');
  const byLabel = (label) => items.find((i) => i.label === label)?.value;
  assert.match(byLabel('Giá'), /^\$315\.00/);
  assert.equal(byLabel('Bóng đèn'), 'E26 — 60W');
  assert.match(byLabel('Chăm sóc'), /dry cloth/i);
  assert.match(byLabel('Chất liệu'), /glass/i);
  assert.match(byLabel('Kích thước'), /H49/);
});
