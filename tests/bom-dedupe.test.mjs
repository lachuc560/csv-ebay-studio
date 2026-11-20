// tests/bom-dedupe.test.mjs — BOM UTF-8 cho mọi file CSV xuất ra + chống
// trùng sản phẩm trong luồng Sheet -> CSV (v8.3).
// Lỗi user báo 16/11/2026 (ảnh Excel mở ebay-DRAFT-beds.csv):
// (1) Dòng cảnh báo DRAFT toàn tiếng Việt bị vỡ thành ký tự lạ ("File
// nhÃ¡p, chÆ°a cÃ³ mÃ£...") vì file CSV xuất ra KHÔNG có UTF-8 BOM,
// Excel trên Windows mở theo bảng mã ANSI. Template thật của eBay và
// template nhúng sẵn đều bắt đầu bằng BOM.
// (2) Nhóm giường chỉ có 2 sản phẩm nhưng file của user có TỚI 4 dòng:
// 2 dòng từ trang crawl + 2 dòng từ sheet fallback, CÙNG CustomLabel cho
// mỗi cặp — do khớp URL chính xác từng ký tự: URL crawl khác URL sheet ở
// dấu "/" cuối thì khớp trượt, sheet item rơi xuống nhánh fallback thành
// 1 sản phẩm riêng trùng id với bản đã crawl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseEbayTemplate, normalizeRecord, parseSheetCsv, parseCsvText,
  templateColumnIndex, autoSheetToCsv, buildDraftTemplateCsv,
  buildEbayTemplateCsv, buildCsv, normalizeProductUrl, dedupeProductsById,
  productFromSheetItem, DRAFT_WARNING_TEXT, CSV_UTF8_BOM,
} from '../public/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const template = parseEbayTemplate(readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8'));
const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };
const colIdx = (name) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '').trim() === name);
function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { rows, headers: rows[1], row: rows[firstDataIdx], rowCount: rows.length - firstDataIdx };
}
function cell(headers, row, name) {
  const i = templateColumnIndex(headers, name);
  return i >= 0 ? (row[i] ?? '') : undefined;
}

// Sheet mẫu 1 dòng giường Carlisle (đúng cột file thật, TYPE để trống để
// nhóm theo từ khoá "bed" trong tiêu đề như sheet thật).
const CARLISLE_URL = 'https://www.sohohome.com/products/carlisle-bedside-table-black-marble';
const BEDS_SHEET =
  'TYPE,SOLD,ACCOUNT,FOLDER,NGÁCH BRAND,TITLE,DESCRIPTION,SIZE,EBAY,Site chính MIN - MAX 100$-1000$,COST,QTY,TOTAL COST,GIÁ BÁN\n' +
  ',,,,SohoHome,"Carlisle Bedside Table, Black Marquina Marble","<div><img src=""https://assets.sohohome.com/images/carlisle.jpg""><p>Bedside table</p></div>",,,' + CARLISLE_URL + ',"$1.795,00",1,"$1.795,00","$1.191,28"\n';

function crawledCarlisle() {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_product_id: 'carlisle-bedside-table-black-marble',
    source_url: `${CARLISLE_URL}/`,
    title: 'Soho Home Carlisle Bedside Table Black Marquina Marble',
    brand: 'Soho Home',
    price: 1795,
    currency: 'USD',
    description_text: 'Bedside table in black Marquina marble.',
    images: ['https://assets.sohohome.com/crawl-carlisle.jpg'],
    variants: [{ options: {}, price: 1795, in_stock: true }],
  });
  return product;
}

// ---- (1) chuẩn hoá URL -----------------------------------------------------

test('normalizeProductUrl: dấu "/" cuối, www, http/https, query, fragment đều về 1 dạng', () => {
  const base = 'https://sohohome.com/products/carlisle-bedside-table-black-marble';
  assert.equal(normalizeProductUrl('https://www.sohohome.com/products/carlisle-bedside-table-black-marble/'), base);
  // Scheme giữ nguyên (chỉ lowercase), host bỏ "www." — http và https
  // vẫn là 2 URL khác nhau về mặt kỹ thuật, nhưng extension và sheet đều
  // dùng https cho Soho Home nên khớp được; không ép https cho site http.
  assert.equal(normalizeProductUrl('http://sohohome.com/products/carlisle-bedside-table-black-marble'), 'http://sohohome.com/products/carlisle-bedside-table-black-marble');
  assert.equal(normalizeProductUrl('https://www.sohohome.com/products/carlisle-bedside-table-black-marble?utm_source=x'), base);
  assert.equal(normalizeProductUrl('https://www.sohohome.com/products/carlisle-bedside-table-black-marble#details'), base);
  assert.equal(normalizeProductUrl('https://www.sohohome.com/products/carlisle-bedside-table-black-marble/?ref=sheet'), base);
  // Query chứa id sản phẩm thì giữ lại (vd trang có ?id=...).
  assert.equal(
    normalizeProductUrl('https://www.example.com/p/shoe?id=123&utm=x'),
    'https://example.com/p/shoe?id=123',
  );
  assert.equal(normalizeProductUrl(''), '');
  assert.equal(normalizeProductUrl(null), '');
});

// ---- (2a) khớp URL đã chuẩn hoá: crawl + sheet -> ĐÚNG 1 sản phẩm --------

test('autoSheetToCsv (v8.3a): URL crawl có "/" cuối + URL sheet không có -> khớp, chỉ 1 sản phẩm, đã enrich GIÁ BÁN', () => {
  const result = autoSheetToCsv(BEDS_SHEET, [crawledCarlisle()], template, config);
  assert.equal(result.stats.products, 1, 'chỉ 1 sản phẩm Carlisle, không tạo thêm bản fallback trùng id');
  assert.equal(result.stats.mergedDuplicateProducts, 0, 'khớp URL đúng nên không cần gộp trùng');
  const p = result.products[0];
  assert.equal(p.title, 'Soho Home Carlisle Bedside Table Black Marquina Marble', 'giữ tiêu đề từ trang crawl');
  assert.equal(p.edits.price, 1191.28, 'GIÁ BÁN $1.191,28 trong sheet làm StartPrice');
  assert.ok((p.images ?? []).includes('https://assets.sohohome.com/crawl-carlisle.jpg'), 'giữ ảnh từ trang crawl');
  // File nháp giường chỉ 1 dòng Carlisle, CustomLabel = id duy nhất.
  assert.equal(result.draftFiles.length, 1);
  const d = result.draftFiles[0];
  assert.equal(d.groupKey, 'beds');
  assert.equal(d.productCount, 1);
  const { headers, row, rowCount } = firstDataRow(d.csv);
  assert.equal(rowCount, 1, 'file nháp giường chỉ 1 dòng Carlisle — lỗi 2 giường thành 4 dòng đã hết');
  assert.equal(cell(headers, row, 'Title'), 'Soho Home Carlisle Bedside Table Black Marquina Marble');
  assert.equal(cell(headers, row, 'StartPrice'), '1191.28');
  assert.equal(cell(headers, row, 'CustomLabel'), p.id);
});

// ---- (2b) lưới an toàn: 2 bản ghi cùng id -> mỗi file chỉ 1 dòng ---------

test('dedupeProductsById: 2 bản ghi cùng id (crawl + sheet fallback) -> 1 bản, giữ dữ liệu crawl + GIÁ BÁN sheet', () => {
  const crawled = crawledCarlisle();
  const { items } = parseSheetCsv(BEDS_SHEET);
  const fallback = productFromSheetItem(items[0]);
  assert.ok(fallback, 'sheet fallback tạo được từ dòng Carlisle');
  assert.equal(fallback.id, crawled.id, 'cùng id (cùng source_site|slug) nên mới trùng CustomLabel');
  assert.equal(fallback.sheet_only, true);
  const { products, mergedDuplicateProducts } = dedupeProductsById([crawled, fallback]);
  assert.equal(mergedDuplicateProducts, 1, 'gộp 1 bản trùng');
  assert.equal(products.length, 1);
  const p = products[0];
  assert.equal(p.id, crawled.id);
  assert.equal(p.title, 'Soho Home Carlisle Bedside Table Black Marquina Marble', 'giữ tiêu đề từ trang crawl');
  assert.ok((p.images ?? []).includes('https://assets.sohohome.com/crawl-carlisle.jpg'), 'giữ ảnh từ trang crawl');
  assert.equal(p.edits.price, 1191.28, 'GIÁ BÁN từ sheet fallback không mất khi gộp');
  assert.equal(p.sheet_only, false, 'đã crawl trang thì không còn cờ sheet_only');
  // Thứ tự ngược lại (fallback trước, crawl sau) vẫn ra 1 bản như nhau.
  const reversed = dedupeProductsById([fallback, crawled]);
  assert.equal(reversed.products.length, 1);
  assert.equal(reversed.products[0].edits.price, 1191.28);
  assert.ok((reversed.products[0].images ?? []).includes('https://assets.sohohome.com/crawl-carlisle.jpg'));
  // Không trùng thì không gộp, không đổi danh sách.
  const single = dedupeProductsById([crawled]);
  assert.equal(single.mergedDuplicateProducts, 0);
  assert.equal(single.products.length, 1);
});

test('dedupeProductsById KHÔNG gộp 2 sản phẩm khác nhau trùng slug/id (Vinnie Bisque vs Vinnie Sage trong sheet thật)', () => {
  // Cả 2 đều có source_product_id "vinnie-cushion" nên cùng id, nhưng là
  // 2 màu khác nhau, URL khác nhau — gộp nhầm là mất 1 sản phẩm (lỗi hồi
  // quy đã gặp khi chỉ so id: gối thật từ 53 còn 52).
  const mk = (slugUrl, title) => normalizeRecord({
    source_site: 'sohohome.com',
    source_product_id: 'vinnie-cushion',
    source_url: slugUrl,
    title,
    brand: 'Soho Home',
    price: 200,
    currency: 'USD',
    images: ['https://assets.sohohome.com/vinnie.jpg'],
    variants: [{ options: {}, price: 200, in_stock: true }],
  }).product;
  const bisque = mk('https://www.sohohome.com/us/products/vinnie-cushion/79958889', 'Soho Home Vinnie Cushion Bisque');
  const sage = mk('https://www.sohohome.com/us/products/vinnie-cushion', 'Soho Home Vinnie Cushion Sage');
  assert.equal(bisque.id, sage.id, 'cùng slug nên cùng id — đó là lý do phải so thêm URL');
  const { products, mergedDuplicateProducts } = dedupeProductsById([bisque, sage]);
  assert.equal(mergedDuplicateProducts, 0, 'không gộp 2 sản phẩm khác nhau');
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((p) => p.title).sort(), [
    'Soho Home Vinnie Cushion Bisque',
    'Soho Home Vinnie Cushion Sage',
  ]);
});

test('autoSheetToCsv (v8.3b): store đã có 2 bản ghi cùng id -> file nháp và file upload được mỗi loại chỉ 1 dòng, CustomLabel không lặp', () => {
  const crawled = crawledCarlisle();
  const { items } = parseSheetCsv(BEDS_SHEET);
  const fallback = productFromSheetItem(items[0]);
  // Mô phỏng dữ liệu local của user đã có 2 bản ghi cùng id (chạy 2 lần
  // trước khi sửa lỗi khớp URL): đưa cả 2 vào, sheet rỗng để không enrich thêm.
  const result = autoSheetToCsv('', [crawled, fallback], template, config);
  assert.equal(result.stats.products, 1, 'gộp lúc xuất, không cần xoá dữ liệu tay');
  assert.equal(result.stats.mergedDuplicateProducts, 1);
  assert.equal(result.draftFiles.length, 1);
  assert.equal(result.draftFiles[0].productCount, 1);
  const { rowCount } = firstDataRow(result.draftFiles[0].csv);
  assert.equal(rowCount, 1);
  // Nửa còn lại: 2 bản gối Daxton cùng id -> file upload được chỉ 1 dòng.
  const { product: daxton } = normalizeRecord({
    source_site: 'sohohome.com',
    source_product_id: 'daxton-square-cushion',
    source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
    title: 'Soho Home Daxton Square Cushion',
    brand: 'Soho Home',
    price: 395,
    currency: 'USD',
    images: ['https://assets.sohohome.com/daxton.jpg'],
    variants: [{ options: {}, price: 395, in_stock: true }],
  });
  const daxtonCopy = { ...daxton, title: 'Daxton Square Cushion', images: [] };
  const result2 = autoSheetToCsv('', [daxton, daxtonCopy], template, config);
  assert.equal(result2.stats.products, 1);
  assert.equal(result2.stats.mergedDuplicateProducts, 1);
  assert.equal(result2.files.length, 1);
  assert.equal(result2.files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(result2.files[0].productCount, 1);
  const up = firstDataRow(result2.files[0].csv);
  assert.equal(up.rowCount, 1, 'file gối upload được chỉ 1 dòng Daxton');
  const labels = up.rows.filter((r) => r[0] === 'Add').map((r) => cell(up.headers, r, 'CustomLabel'));
  assert.deepEqual(labels, [daxton.id], 'CustomLabel không lặp');
});

// ---- (1) BOM UTF-8 cho mọi file CSV xuất ra -------------------------------

test('CSV xuất ra bắt đầu bằng BOM UTF-8 (EF BB BF): file nháp, file upload được, buildCsv cũ', () => {
  const { product: lamp } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'archie-table-lamp',
    source_url: 'https://www.sohohome.com/us/products/archie-table-lamp',
    title: 'Soho Home Archie Table Lamp', brand: 'Soho Home', price: 300,
    currency: 'USD', images: ['https://assets.sohohome.com/x.jpg'],
    variants: [{ options: {}, price: 300, in_stock: true }],
  });
  const { product: cushion } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'daxton-square-cushion',
    source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
    title: 'Soho Home Daxton Square Cushion', brand: 'Soho Home', price: 395,
    currency: 'USD', images: ['https://assets.sohohome.com/daxton.jpg'],
    variants: [{ options: {}, price: 395, in_stock: true }],
  });
  const draft = buildDraftTemplateCsv([lamp], template, config);
  const upload = buildEbayTemplateCsv([cushion], template, config);
  const legacy = buildCsv([cushion], config);
  for (const [name, csvText] of [['nháp', draft], ['upload được', upload], ['buildCsv cũ', legacy]]) {
    assert.equal(csvText.charCodeAt(0), 0xfeff, `file ${name} phải bắt đầu bằng BOM`);
    assert.ok(csvText.startsWith(CSV_UTF8_BOM), `file ${name} bắt đầu bằng CSV_UTF8_BOM`);
  }
  // Bỏ BOM thì dòng DRAFT đọc đúng tiếng Việt (không còn "nhÃ¡p" như ảnh lỗi).
  const draftNoBom = draft.replace(/^\uFEFF/, '');
  const { rows } = firstDataRow(draftNoBom);
  assert.equal(rows[2][0], 'DRAFT');
  assert.equal(rows[2][1], DRAFT_WARNING_TEXT);
  assert.ok(rows[2][1].includes('File nháp, chưa có mã danh mục'), 'dòng DRAFT đọc đúng tiếng Việt');
  assert.ok(!rows[2][1].includes('nhÃ¡p'), 'không còn chữ vỡ do thiếu BOM');
});

test('parse lại file CSV có BOM: vẫn đủ header 98 cột + dữ liệu, không mất dòng', () => {
  const { product: cushion } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'daxton-square-cushion',
    source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
    title: 'Soho Home Daxton Square Cushion', brand: 'Soho Home', price: 395,
    currency: 'USD', images: ['https://assets.sohohome.com/daxton.jpg'],
    variants: [{ options: {}, price: 395, in_stock: true }],
  });
  const csvText = buildEbayTemplateCsv([cushion], template, config);
  assert.ok(csvText.charCodeAt(0) === 0xfeff, 'file xuất ra có BOM');
  const rows = parseCsvText(csvText);
  assert.equal(rows[0][0], 'Info', 'parse bỏ BOM, dòng Version vẫn đọc đúng');
  assert.deepEqual(rows[1], template.headers, 'header vẫn đủ 98 cột');
  const data = rows.filter((r) => r[0] === 'Add');
  assert.equal(data.length, 1);
  assert.equal(data[0][colIdx('Title')], 'Soho Home Daxton Square Cushion');
});

// ---- sheet thật: giường vẫn đúng 2 dòng, không còn 4 dòng ------------------

test('autoSheetToCsv (sheet thật 117 dòng, v8.3): file nháp giường đúng 2 dòng Carlisle + Avery, mỗi file có BOM', () => {
  const csvText = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const result = autoSheetToCsv(csvText, [], template, config);
  assert.equal(result.stats.mergedDuplicateProducts, 0, 'sheet thật không có bản trùng');
  const beds = result.draftFiles.find((d) => d.groupKey === 'beds');
  assert.ok(beds, 'có file nháp giường');
  assert.equal(beds.productCount, 2);
  const { headers, rows, rowCount } = firstDataRow(beds.csv);
  assert.equal(rowCount, 2, 'giường đúng 2 dòng dữ liệu, không còn 4 dòng như file lỗi của user');
  const titles = rows.filter((r) => r[0] === 'Add').map((r) => cell(headers, r, 'Title'));
  assert.ok(titles.some((t) => t.includes('Carlisle Bedside Table')));
  assert.ok(titles.some((t) => t.includes('Avery Bedside Table')));
  const labels = rows.filter((r) => r[0] === 'Add').map((r) => cell(headers, r, 'CustomLabel'));
  assert.equal(new Set(labels).size, 2, 'CustomLabel không lặp');
  for (const d of [...result.draftFiles, ...result.files]) {
    assert.equal(d.csv.charCodeAt(0), 0xfeff, `file ${d.filename} phải bắt đầu bằng BOM`);
  }
});
