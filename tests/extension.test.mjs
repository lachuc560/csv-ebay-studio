import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRecord } from '../public/core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf-8');

test('extension v2: manifest 1.4.0, mở dạng bảng bên cạnh (side panel), KHÔNG còn popup/quyền downloads', () => {
  const m = JSON.parse(read('extension-v2/manifest.json'));
  assert.equal(m.version, '1.4.0');
  assert.equal(m.side_panel?.default_path, 'popup.html', 'giao diện mở trong side panel');
  assert.equal(m.action?.default_popup, undefined, 'không còn popup tự đóng khi đổi tab');
  assert.equal(m.background?.service_worker, 'dist/background.js');
  assert.ok(m.permissions.includes('sidePanel'));
  assert.ok(m.permissions.includes('tabs'), 'bảng bên cạnh cần biết URL tab đang xem khi đổi tab');
  assert.ok(m.permissions.includes('scripting'));
  assert.ok(!m.permissions.includes('downloads'), 'quyền downloads chỉ phục vụ luồng 1 nút Sheet → CSV đã bỏ từ v9.2');
  assert.ok(Number(m.minimum_chrome_version) >= 116, 'sidePanel.setPanelBehavior cần Chrome 116+');
});

test('extension v1.4.0: service worker bật mở side panel khi bấm icon', () => {
  const bg = read('extension-v2/dist/background.js');
  assert.ok(bg.includes('setPanelBehavior({ openPanelOnActionClick: true })'));
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/background.js`]);
});

test('extension v1.4.0: bảng bên cạnh theo dõi tab, giữ kết quả từng trang, xin quyền theo website', () => {
  const js = read('extension-v2/dist/popup.js');
  assert.ok(js.includes('chrome.tabs.onActivated.addListener'), 'đổi tab thì cập nhật bảng');
  assert.ok(js.includes('chrome.tabs.onUpdated.addListener'), 'đổi trang trong cùng tab thì cập nhật bảng');
  assert.ok(js.includes('resultsByUrl'), 'kết quả crawl lưu theo từng trang, quay lại tab vẫn thấy');
  assert.ok(js.includes('ensureSiteAccess(tab.url)'), 'xin quyền đọc website trước khi chèn content script');
  assert.ok(js.includes('Đã crawl xong trang trước'), 'crawl xong khi đã chuyển tab vẫn báo kết quả');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/popup.js`]);
});

test('extension v1.3.8: popup có timeout, bắt lỗi JSON, nút Lưu luôn được mở lại, gửi trang chờ', () => {
  const js = read('extension-v2/dist/popup.js');
  assert.ok(js.includes('AbortSignal.timeout(timeoutMs)'), 'fetch có timeout');
  assert.ok(js.includes('EXTRACT_TIMEOUT_MS'), 'extract-page dùng timeout dài riêng');
  assert.ok(js.includes('new ApiError("timeout")'), 'timeout báo lỗi riêng');
  assert.match(js, /try \{\s*data = await res\.json\(\);/, 'res.json() lỗi không lộ SyntaxError thô');
  assert.match(js, /finally \{\s*saveBtn\.disabled = false;/, 'nút Lưu luôn mở lại kể cả khi lỗi');
  assert.ok(js.includes('flushPendingPages'), 'trang lưu local được gửi khi đã kết nối');
  assert.ok(js.indexOf('await chrome.storage.local.set(settings)') > js.indexOf('const ok = await checkConnection()'), 'chỉ lưu cấu hình sau khi kết nối thành công');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/popup.js`]);
});

test('extension v2: content.js có readSohoHome và nối vào extractCsvRecord', () => {
  const js = read('extension-v2/dist/content.js');
  assert.ok(js.includes('function readSohoHome()'));
  assert.ok(js.includes('product.source === "SohoHome"'));
  assert.ok(js.includes('sohohome'));
  assert.ok(js.includes('specs: read?.sohoSpecs'));
  assert.ok(js.includes('Regular Price'), 'compare-at lấy từ "Regular Price", không lấy Member price');
  assert.ok(js.includes('parsePrice(offer)'), 'giá lấy từ JSON-LD offers (giá non-member), không đọc giá Member');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/content.js`]);
});

test('extension v1.3.3: popup CHỈ còn nút "Crawl AI trang này" — không còn nút cũ, không còn Sheet/bulk', () => {
  const js = read('extension-v2/dist/popup.js');
  const html = read('extension-v2/popup.html');
  // Chỉ còn nút AI.
  assert.ok(html.includes('id="aiCrawl"'), 'popup có nút aiCrawl');
  assert.ok(html.includes('Crawl AI trang này'), 'popup có nhãn nút AI');
  assert.ok(js.includes('aiCrawl'), 'popup.js có luồng aiCrawl');
  assert.ok(js.includes('EXTRACT_AI_PAGE'), 'popup gửi EXTRACT_AI_PAGE cho content script');
  assert.ok(js.includes('ingest/extract-page'), 'popup gọi POST /api/ingest/extract-page bằng khóa crawl');
  assert.ok(js.includes('aiPagePending'), 'chưa cấu hình tool thì giữ bản copy local (aiPagePending)');
  // Nút "Crawl trang này" cũ đã bỏ.
  assert.ok(!html.includes('id="crawl"'), 'popup v1.3.0 không còn nút Crawl trang này cũ');
  assert.ok(!js.includes('function crawl('), 'popup.js không còn hàm crawl() cũ');
  assert.ok(!js.includes('describeResult'), 'popup.js không còn describeResult của nút cũ');
  // Card Sheet → CSV + mục bulk đã bỏ hoàn toàn.
  assert.ok(!html.includes('id="bulkCard"'), 'popup không còn card Sheet → CSV');
  assert.ok(!html.includes('id="sheetUrl"'), 'popup không còn ô dán link Google Sheet');
  assert.ok(!html.includes('id="sheetAutoBtn"'), 'popup không còn nút Lấy từ Sheet và xuất CSV');
  assert.ok(!html.includes('id="sheetFetchBtn"'), 'popup không còn nút lấy link từ Sheet');
  assert.ok(!html.includes('id="bulkList"'), 'popup không còn ô danh sách link bulk');
  assert.ok(!html.includes('id="bulkStart"'), 'popup không còn nút Crawl danh sách');
  assert.ok(!html.includes('id="autoStop"'), 'popup không còn nút Dừng của luồng tự động');
  assert.ok(!js.includes('runSheetAuto'), 'popup.js không còn runSheetAuto');
  assert.ok(!js.includes('runBulk'), 'popup.js không còn runBulk');
  assert.ok(!js.includes('crawlOneBulkUrl'), 'popup.js không còn crawlOneBulkUrl');
  assert.ok(!js.includes('crawlOneAutoUrl'), 'popup.js không còn crawlOneAutoUrl');
  assert.ok(!js.includes('fetchGoogleSheetCsv'), 'popup.js không còn fetchGoogleSheetCsv');
  assert.ok(!js.includes('autoSheetToCsv'), 'popup.js không còn autoSheetToCsv');
  assert.ok(!js.includes('docs.google.com'), 'popup.js không còn xin quyền docs.google.com');
  assert.ok(!js.includes('chrome.downloads.download'), 'popup.js không còn tự tải CSV bằng chrome.downloads');
  assert.ok(!js.includes('ebay-template-20563.csv'), 'popup.js không còn template 20563 nhúng sẵn');
  assert.ok(!existsSync(`${root}extension-v2/ebay-template-20563.csv`), 'extension-v2 không còn file template nhúng sẵn');
  assert.ok(!html.includes('dist/core.js'), 'popup không còn load dist/core.js (không còn code nào dùng CsvEbayCore)');
  assert.ok(!existsSync(`${root}extension-v2/dist/core.js`), 'extension-v2 không còn dist/core.js');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/popup.js`]);
});

test('extension v1.3.3: content.js KHÔNG còn nhánh EXTRACT_CSV (extractCsvRecord vẫn giữ cho EXTRACT_AI_PAGE)', () => {
  const js = read('extension-v2/dist/content.js');
  assert.ok(!js.includes('"EXTRACT_CSV"'), 'content.js không còn nhận message EXTRACT_CSV');
  assert.ok(js.includes('function extractCsvRecord('), 'extractCsvRecord vẫn giữ vì extractAiPage dùng chung');
  assert.ok(js.includes('EXTRACT_AI_PAGE'), 'content.js vẫn nhận EXTRACT_AI_PAGE');
  assert.ok(js.includes('EXTRACT_EBAY_SOLD'), 'content.js giữ EXTRACT_EBAY_SOLD làm dự phòng');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/content.js`]);
});

test('extension v1.0.0 gốc không bị sửa', () => {
  const m = JSON.parse(read('extension-v1.0.0/manifest.json'));
  assert.equal(m.version, '1.0.0');
  assert.ok(!read('extension-v1.0.0/dist/content.js').includes('readSohoHome'));
});

test('Soho record có specs: normalizeRecord giữ specs để xuất template', () => {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'cavern-side-table',
    title: 'Cavern Side Table', brand: 'Soho Home', price: 1470,
    images: ['https://x/1.jpg'],
    specs: { Dimensions: 'H45 x W50 x D50cm / H18 x W20 x D20"', Material: 'Ash Wood' },
    variants: [{ options: {}, price: 1470, compare_at_price: 2095, in_stock: true }],
  });
  assert.equal(product.specs.Dimensions, 'H45 x W50 x D50cm / H18 x W20 x D20"');
  assert.equal(product.variants[0].compare_at_price, 2095);
  assert.ok(existsSync(`${root}dist/extension-v1.4.0.zip`));
});

test('extension v1.3.3: Crawl AI 1 trang — content script đọc dữ liệu thô cho server', () => {
  const js = read('extension-v2/dist/content.js');
  assert.ok(js.includes('EXTRACT_AI_PAGE'), 'content.js nhận EXTRACT_AI_PAGE');
  assert.ok(js.includes('function extractAiPage('), 'content.js có extractAiPage');
  assert.ok(js.includes('function pageVisibleText('), 'content.js có pageVisibleText');
  assert.ok(js.includes('pageVisibleText(12000)'), 'text trang giới hạn ~12.000 ký tự');
  assert.ok(js.includes('pageText'), 'extractAiPage trả pageText');
  assert.ok(js.includes('jsonLd'), 'extractAiPage trả JSON-LD');
  assert.ok(js.includes('record.variants'), 'extractAiPage kèm biến thể từ reader');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/content.js`]);
});

test('extension v1.3.3: popup hiện danh sách "Đã cào được" gọn sau khi crawl AI', () => {
  const js = read('extension-v2/dist/popup.js');
  const html = read('extension-v2/popup.html');
  assert.ok(html.includes('id="crawledWrap"'), 'popup có khung danh sách Đã cào được');
  assert.ok(html.includes('id="crawledList"'), 'popup có ul danh sách Đã cào được');
  assert.ok(html.includes('Đã cào được'), 'popup có tiêu đề "Đã cào được"');
  assert.ok(js.includes('renderCrawledList'), 'popup.js vẽ danh sách Đã cào được sau khi crawl');
  assert.ok(js.includes('crawledListItems'), 'popup.js có hàm dựng các dòng Đã cào được');
  // Đủ 13 dòng như web: tiêu đề, giá, ảnh, mô tả, chất liệu, kích thước,
  // bóng đèn, chăm sóc, biến thể, listing khớp, đã bán, người theo dõi,
  // mã danh mục.
  for (const label of ['Tiêu đề', 'Giá', 'Ảnh', 'Mô tả', 'Chất liệu', 'Kích thước', 'Bóng đèn', 'Chăm sóc', 'Biến thể', 'Listing eBay khớp', 'Đã bán (eBay)', 'Người theo dõi', 'Mã danh mục']) {
    assert.ok(js.includes(`label: '${label}'`), `popup có dòng "${label}"`);
  }
  assert.ok(js.includes("'chưa có'"), 'trường thiếu hiện "chưa có", không bịa');
  assert.ok(js.includes('renderCrawledList(result)'), 'crawl thành công thì vẽ danh sách');
  assert.ok(js.includes('Đã cào xong'), 'trạng thái sau crawl gọn 1 dòng, chi tiết nằm trong danh sách');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/popup.js`]);
});

test('extension v1.3.3: KHÔNG còn card dán link eBay tay — web tự khớp listing qua Browse API', () => {
  const js = read('extension-v2/dist/content.js');
  const popup = read('extension-v2/dist/popup.js');
  const html = read('extension-v2/popup.html');
  // content.js GIỮ EXTRACT_EBAY_SOLD làm dự phòng khi Browse API không trả
  // số đã bán cho listing đó (đọc "X sold" công khai trên trang eBay).
  assert.ok(js.includes('EXTRACT_EBAY_SOLD'), 'content.js giữ EXTRACT_EBAY_SOLD làm dự phòng');
  assert.ok(js.includes('function extractEbaySold('), 'content.js có extractEbaySold');
  // Nhưng popup KHÔNG còn ô dán link / nút lấy số đã bán tay nữa.
  assert.ok(!html.includes('id="ebaySoldBtn"'), 'popup v1.3.0 không còn nút lấy số đã bán tay');
  assert.ok(!html.includes('id="ebayUrl"'), 'popup v1.3.0 không còn ô dán link listing eBay');
  assert.ok(!popup.includes('fetchEbaySold'), 'popup.js không còn hàm fetchEbaySold');
  // Sau "Crawl AI trang này", popup hiện listing eBay đã khớp tự động.
  assert.ok(popup.includes('result.enrichment'), 'popup đọc enrichment trả về từ extract-page');
  assert.ok(popup.includes('người theo dõi'), 'popup hiện số người theo dõi đã khớp tự động');
  assert.ok(!/watchcount\.com/i.test(js), 'content.js không gọi watchcount');
  assert.ok(!/watchcount\.com/i.test(popup), 'popup.js không gọi watchcount');
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/content.js`]);
  execFileSync(process.execPath, ['--check', `${root}extension-v2/dist/popup.js`]);
});
