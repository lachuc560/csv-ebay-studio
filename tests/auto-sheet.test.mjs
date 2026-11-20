// tests/auto-sheet.test.mjs — Luồng 1 nút "Sheet -> CSV tự động" (v4).
// Test bằng file sheet THẬT của user: Sabo_Lucky_Rate 9, tab Soho Home
// (117 sản phẩm, link đúng 14cct-PApWoMitLN3s3ARidrnZUN0ui74ubqcPH5ipsg,
// gid 852166301), cộng sheet mẫu nhỏ 3 dòng (1 gối, 1 thảm, 1 bàn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseMoneyCell,
  parseSheetCsv,
  parseEbayTemplate,
  parseCsvText,
  autoSheetToCsv,
  mapEbayType,
  resolveThemeGroup,
  extractImageFromHtml,
} from '../public/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Sheet thật của user, copy vào tests/fixtures/ để test tự chạy được trong
// zip (không phụ thuộc file ngoài repo). Bản gốc:
// ~/workspace/user/files/Sabo_Lucky_Rate_9_Soho_Home.csv
const realSheetPath = path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv');
const realSheetText = readFileSync(realSheetPath, 'utf-8');
const templateText = readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8');
const template = parseEbayTemplate(templateText);

const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };
const colIdx = (name) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '').trim() === name);
const allowedTypes = template.recommendedValues['Type'] ?? [];

// Sheet mẫu 3 dòng: 1 gối, 1 thảm, 1 bàn (cột đúng file thật, có GIÁ BÁN).
const SAMPLE_SHEET =
  'TYPE,SOLD,ACCOUNT,FOLDER,NGÁCH BRAND,TITLE,DESCRIPTION,SIZE,EBAY,Site chính MIN - MAX 100$-1000$,COST,QTY,TOTAL COST,GIÁ BÁN\n' +
  ',,,,SohoHome,Soho Home Daxton Square Cushion,"<div><img src=""https://assets.sohohome.com/images/daxton.jpg""><p>Italian jacquard cushion</p></div>",,https://www.sohohome.com/us/products/daxton-square-cushion/79996850,https://www.sohohome.com/us/products/daxton-square-cushion/79996850,"$395,00",1,"$395,00","$280,00"\n' +
  ',,,,SohoHome,Soho Home Catherine Rug,"<div>Rug</div>",200x200cm,,https://www.sohohome.com/us/products/catherine-rug-navy-round/79900001,"$2.450,00",1,"$2.450,00","$1.700,00"\n' +
  ',,,,SohoHome,Soho Home Cavern Side Table,"<div>Side table</div>",,,https://www.sohohome.com/us/products/cavern-side-table/79900002,"$1.470,00",1,"$1.470,00","$1.029,00"\n';

function sampleRecord(url, title, price) {
  return {
    id: `p_${title.length}_${price}`,
    version: 1,
    source_site: 'sohohome.com',
    source_product_id: url.split('/').filter(Boolean).pop(),
    source_url: url,
    title,
    brand: 'Soho Home',
    price,
    currency: 'USD',
    description: null,
    images: [],
    variants: [{ options: {}, price, in_stock: true }],
    edits: {},
  };
}

test('parseMoneyCell: định dạng châu Âu của sheet thật ($395,00 / $1.295,00 / $0,49) và Mỹ ($1,295.00)', () => {
  assert.equal(parseMoneyCell('$395,00'), 395);
  assert.equal(parseMoneyCell('$1.295,00'), 1295);
  assert.equal(parseMoneyCell('$0,49'), 0.49);
  assert.equal(parseMoneyCell('$859,58'), 859.58);
  assert.equal(parseMoneyCell('$1,295.00'), 1295);
  assert.equal(parseMoneyCell('$395.00'), 395);
  assert.equal(parseMoneyCell('$2.450,00'), 2450);
  assert.equal(parseMoneyCell(''), null);
  assert.equal(parseMoneyCell('$0'), null);
});

test('template nhúng sẵn: category 20563, 98 cột, Type có 22 giá trị cho phép', () => {
  assert.equal(template.categoryId, '20563');
  assert.equal(template.headers.length, 98);
  assert.equal(allowedTypes.length, 22);
  assert.ok(allowedTypes.includes('Throw Pillow'));
  assert.ok(allowedTypes.includes('Cushion'));
  assert.ok(allowedTypes.includes('Bolster'));
  assert.ok(allowedTypes.includes('Pillow Cover'));
});

test('resolveThemeGroup + mapEbayType: NGÁCH tiếng Việt trong sheet', () => {
  assert.equal(resolveThemeGroup('Gối').key, 'cushions');
  assert.equal(resolveThemeGroup('Gối').categoryId, '20563');
  assert.equal(resolveThemeGroup('Thảm').key, 'rugs');
  assert.equal(resolveThemeGroup('Đèn').key, 'lighting');
  assert.equal(resolveThemeGroup('Gương').key, 'mirrors');
  assert.equal(resolveThemeGroup('Bàn').key, 'tables');
  assert.equal(mapEbayType({ title: 'Soho Home Gối ôm', theme: 'Gối ôm' }, template), 'Bolster');
  assert.equal(mapEbayType({ title: 'Soho Home Gối', theme: 'Gối' }, template), 'Throw Pillow');
  assert.equal(mapEbayType({ title: 'Soho Home Tilney Square Sham' }, template), 'Pillow Cover');
  assert.equal(mapEbayType({ title: 'Soho Home Daxton Square Cushion' }, template), 'Cushion');
});

test('parseSheetCsv file thật: 117 link, EBAY trống 114 dòng vẫn lấy được Site chính, cả 2 cột có thì ưu tiên EBAY', () => {
  const { items, invalid } = parseSheetCsv(realSheetText);
  assert.equal(items.length, 117);
  assert.deepEqual(invalid, []);
  // Daxton: chỉ có Site chính, COST/GIÁ BÁN châu Âu.
  const daxton = items.find((it) => it.url.includes('daxton-square-cushion/79996850'));
  assert.ok(daxton, 'tìm thấy Daxton');
  assert.equal(daxton.title, 'Soho Home Daxton Square Cushion');
  assert.equal(daxton.cost, 395, 'COST $395,00 = 395, không phải 39500');
  assert.equal(daxton.gia_ban, 280, 'GIÁ BÁN $280,00 = 280');
  // Betty Wall Mirror: COST $1.295,00 = 1295, GIÁ BÁN $859,58.
  const betty = items.find((it) => it.title?.includes('Betty Wall Mirror'));
  assert.equal(betty.cost, 1295);
  assert.equal(betty.gia_ban, 859.58);
  // 3 dòng có cả 2 cột: ưu tiên URL cột EBAY.
  const urls = new Set(items.map((it) => it.url));
  assert.ok(urls.has('https://www.sohohome.com/us/products/charlton-towel-rack-nickel/79933534'), 'EBAY Charlton (slug khác Site chính)');
  assert.ok(urls.has('https://www.sohohome.com/us/products/mayfair-towel-rack-brass/79933411'), 'EBAY Mayfair (ID 79933411, khác Site chính 79933428)');
  assert.ok(urls.has('https://www.sohohome.com/us/products/mayfair-toilet-roll-holder-brass/79933435'));
  // DESCRIPTION trong sheet đã là HTML đầy đủ, có ảnh chính.
  assert.ok(daxton.description.includes('assets.sohohome.com'));
  assert.ok(extractImageFromHtml(daxton.description).startsWith('https://assets.sohohome.com/'));
});

test('parseSheetCsv file thật: 4 dòng trống TITLE/COST (GIÁ BÁN $0,49) vẫn giữ lại để báo cáo, không bịa tên/giá', () => {
  const { items } = parseSheetCsv(realSheetText);
  const empty = items.filter((it) => !it.title);
  assert.equal(empty.length, 4);
  assert.deepEqual(
    empty.map((it) => it.source_row).sort((a, b) => a - b),
    [7, 59, 73, 76],
  );
  for (const it of empty) {
    assert.equal(it.cost, null);
    assert.equal(it.gia_ban, 0.49);
  }
  assert.ok(empty.some((it) => it.url.includes('mayfair-toilet-brush-holder')));
  assert.ok(empty.some((it) => it.url.includes('daxton-square-cushion') && !it.url.includes('/79996850')));
  assert.ok(empty.some((it) => it.url.includes('vende-cushion')));
  assert.ok(empty.some((it) => it.url.includes('antonia-cushion')));
});

test('autoSheetToCsv file thật (chưa crawl trang): ra đúng 1 file gối 20563, nhóm khác bị bỏ qua kèm lý do, 4 dòng trống bị loại', () => {
  const result = autoSheetToCsv(realSheetText, [], template, config);
  assert.equal(result.stats.sheetLinks, 117);
  assert.equal(result.stats.products, 113, '117 link - 4 dòng trống = 113 sản phẩm');
  assert.equal(result.files.length, 1, 'chỉ nhóm gối có template 20563');
  assert.equal(result.files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(result.files[0].productCount, 53, 'gối 51 + sham 2 = 53');
  assert.equal(result.stats.exportedProducts, 53);
  // Nhóm chưa có template: đèn 39, gương 7, phòng tắm 8, ghế 3, giường 2, tủ 1 — không xuất nhầm sang template gối.
  const skippedByKey = Object.fromEntries(result.skipped.map((s) => [s.key, s.productCount]));
  assert.equal(skippedByKey.lighting, 39);
  assert.equal(skippedByKey.mirrors, 7);
  assert.equal(skippedByKey.bath, 8);
  assert.equal(skippedByKey.seating, 3);
  assert.equal(skippedByKey.beds, 2);
  assert.equal(skippedByKey.storage, 1);
  assert.equal(result.skipped.length, 6);
  assert.ok(!result.groups.some((g) => g.key === 'other'), 'không còn nhóm Other');
  // 4 dòng trống TITLE/COST bị loại, ghi rõ lý do, không tự bịa tên/giá.
  assert.equal(result.stats.skippedSheetRows, 4);
  assert.deepEqual(
    result.skippedSheetRows.map((s) => s.source_row).sort((a, b) => a - b),
    [7, 59, 73, 76],
  );
  assert.ok(result.skippedSheetRows.every((s) => /trống TITLE|thiếu dữ liệu/i.test(s.reason)));
  // Cảnh báo trường còn trống trước khi upload.
  assert.ok(result.warnings.some((w) => /Location/.test(w)));
  assert.ok(result.warnings.some((w) => /DispatchTimeMax/.test(w)));
  assert.ok(result.warnings.some((w) => /ReturnsAcceptedOption/.test(w)));
});

test('file gối thật: header khớp template 100%, 53 dòng, Title ≤80, Type trong 22 giá trị, StartPrice = GIÁ BÁN trong sheet, PicURL đủ', () => {
  const result = autoSheetToCsv(realSheetText, [], template, config);
  const rows = parseCsvText(result.files[0].csv);
  assert.deepEqual(rows[1], template.headers, 'header dòng 2 khớp template 100%');
  const data = rows.slice(2 + template.infoRows.length);
  assert.equal(data.length, 53);
  for (const r of data) {
    assert.ok(r[colIdx('Title')].length <= 80, `Title >80: ${r[colIdx('Title')]}`);
    assert.ok(allowedTypes.includes(r[colIdx('C:Type')]), `Type ngoài danh sách: ${r[colIdx('C:Type')]}`);
    assert.ok(r[colIdx('PicURL')], 'PicURL trống — ảnh chính phải lấy từ DESCRIPTION sheet');
    assert.ok(r[colIdx('PicURL')].startsWith('https://assets.sohohome.com/'));
    assert.ok(!r[colIdx('Description')].includes('<img'), 'Description không được còn thẻ <img> (ảnh đã ở PicURL)');
    assert.ok(!r[colIdx('Description')].includes('<script'), 'Description không được còn <script>');
    assert.equal(r[colIdx('Action')], 'Add');
    assert.equal(r[colIdx('Category')], '20563');
    assert.equal(r[colIdx('ConditionID')], '1000');
    assert.equal(r[colIdx('Format')], 'FixedPrice');
    assert.equal(r[colIdx('Quantity')], '1');
  }
  const daxton = data.find((r) => r[colIdx('Title')] === 'Soho Home Daxton Square Cushion');
  assert.ok(daxton);
  assert.equal(daxton[colIdx('C:Type')], 'Cushion');
  assert.equal(daxton[colIdx('C:Brand')], 'Soho Home');
  assert.equal(daxton[colIdx('StartPrice')], '280.00', 'StartPrice = GIÁ BÁN $280 trong sheet, KHÔNG tính lại từ COST $395');
  const types = [...new Set(data.map((r) => r[colIdx('C:Type')]))].sort();
  assert.deepEqual(types, ['Cushion', 'Pillow Cover'], 'gối -> Cushion, sham -> Pillow Cover');
});

test('autoSheetToCsv: báo cáo thiếu trường ghi rõ Brand Soho Home chưa trong danh sách template', () => {
  const result = autoSheetToCsv(realSheetText, [], template, config);
  const daxton = result.missing.find((m) => m.title === 'Soho Home Daxton Square Cushion');
  assert.ok(daxton);
  assert.ok(daxton.missing.some((m) => /Brand "Soho Home" không có trong danh sách/i.test(m)));
  assert.ok(daxton.missing.some((m) => /chưa crawl trang sản phẩm/i.test(m)));
});

test('autoSheetToCsv mẫu 3 dòng + record tương ứng: 1 file gối, thảm/bàn bị bỏ qua kèm lý do', () => {
  const records = [
    sampleRecord('https://www.sohohome.com/us/products/daxton-square-cushion/79996850', 'Soho Home Daxton Square Cushion', 1470),
    sampleRecord('https://www.sohohome.com/us/products/catherine-rug-navy-round/79900001', 'Soho Home Catherine Rug Navy Round', 2450),
    sampleRecord('https://www.sohohome.com/us/products/cavern-side-table/79900002', 'Soho Home Cavern Side Table', 1470),
  ];
  const result = autoSheetToCsv(SAMPLE_SHEET, records, template, config);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(result.files[0].productCount, 1);
  const skippedByKey = Object.fromEntries(result.skipped.map((s) => [s.key, s.productCount]));
  assert.equal(skippedByKey.rugs, 1);
  assert.equal(skippedByKey.tables, 1);
  assert.ok(result.skipped.every((s) => /chưa có categoryId|template/i.test(s.reason)));
  // Record đã crawl được gộp dữ liệu sheet: GIÁ BÁN $280 làm StartPrice, không tính lại từ giá trang $1470.
  const rows = parseCsvText(result.files[0].csv);
  const data = rows.slice(2 + template.infoRows.length);
  assert.equal(data.length, 1);
  assert.equal(data[0][colIdx('StartPrice')], '280.00');
  assert.equal(data[0][colIdx('C:Type')], 'Cushion');
  assert.ok(data[0][colIdx('PicURL')].includes('assets.sohohome.com'), 'ảnh từ DESCRIPTION sheet khi trang chưa có ảnh');
});
