import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { autoApplyEbayResolutions, crawledSummaryItems, resolvedCategoryFromEdits } from '../public/core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf-8');
const appJs = () => read('public/app.js');

function makeProducts() {
  return [
    {
      id: 'p1', title: 'Daxton Square Cushion', price: 280, currency: 'USD',
      images: ['https://x/1.jpg', 'https://x/2.jpg'],
      description: 'A plush square cushion in soft linen.',
      specs: { Material: 'Linen', Dimensions: '20 x 20 in' },
      variants: [
        { options: { Color: 'Olive', Size: '20 x 20 in' }, price: 280, in_stock: true },
        { options: { Color: 'Rust', Size: '20 x 20 in' }, price: 280, in_stock: false },
      ],
      version: 1, edits: {},
    },
    {
      id: 'p2', title: 'Halsey Square Cushion', price: 250, currency: 'USD',
      images: ['https://x/3.jpg'], description: 'Soft cushion.',
      specs: { Material: 'Cotton' },
      variants: [{ options: { Color: 'Blue', Size: '20 x 20 in' }, price: 250, in_stock: true }],
      version: 3, edits: {},
    },
  ];
}

function verifiedResult(groupKey = 'lighting') {
  return {
    groupKey, categoryId: '19591', categoryName: 'Lighting Kits',
    categoryPath: 'Home & Garden > Lamps > Lighting Kits',
    verifiedFromEbay: true,
    requiredAspects: [{ name: 'Brand' }, { name: 'Type' }],
    recommendedAspects: [],
  };
}

test('v9.3 (a): mã verified → PUT ebayCategoryId cho từng sản phẩm trong nhóm, không còn nút áp mã', async () => {
  const products = makeProducts();
  const groups = [{ key: 'lighting', label: 'Lighting', products }];
  const calls = [];
  const putProduct = async (p, edits) => {
    calls.push([p.id, edits]);
    const updated = { ...p, edits, version: (p.version ?? 1) + 1 };
    return updated;
  };
  const out = await autoApplyEbayResolutions([verifiedResult()], groups, putProduct);
  assert.equal(out.applied, 2);
  assert.equal(out.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].ebayCategoryId, '19591');
  assert.equal(calls[0][1].ebayCategoryName, 'Lighting Kits');
  assert.deepEqual(calls[0][1].ebayRequiredAspects, [{ name: 'Brand', values: [] }, { name: 'Type', values: [] }]);
  assert.equal(products[0].edits.ebayCategoryId, '19591');
  assert.equal(products[0].version, 2);
  // Sản phẩm đã có đúng mã rồi thì không PUT lại.
  const calls2 = [];
  const out2 = await autoApplyEbayResolutions([verifiedResult()], groups, async (p, edits) => { calls2.push(p.id); return p; });
  assert.equal(calls2.length, 0);
  assert.equal(out2.applied, 2);
  // Web: không còn nút "Áp dụng mã" nào, không còn handler cũ.
  const js = appJs();
  assert.ok(!js.includes('Áp dụng mã'), 'app.js không còn chữ "Áp dụng mã"');
  assert.ok(!js.includes('data-apply-ebay'), 'app.js không còn nút data-apply-ebay');
  assert.ok(!js.includes('applyEbayResolution'), 'app.js không còn hàm applyEbayResolution');
  assert.ok(!js.includes('apiPut('), 'app.js không còn gọi apiPut (hàm này chưa từng tồn tại — lỗi có từ v9.2)');
  assert.ok(js.includes('autoApplyEbayResolutions'), 'resolveEbayGroups gọi autoApplyEbayResolutions');
  assert.ok(js.includes('Mã danh mục eBay — đã tự áp vào sản phẩm'), 'bảng kết quả tra mã là bảng chỉ-đọc đã tự áp');
  assert.ok(js.includes('<th>Nhóm</th><th>Mã eBay</th><th>Đường dẫn / trường bắt buộc</th>'), 'bảng kết quả chỉ còn 3 cột, không còn cột nút');
});

test('v9.3 (a2): lỗi 409 ở 1 sản phẩm → chỉ tính failed, các sản phẩm khác vẫn áp, không throw', async () => {
  const products = makeProducts();
  const groups = [{ key: 'lighting', label: 'Lighting', products }];
  const putProduct = async (p, edits) => {
    if (p.id === 'p2') {
      const err = new Error('version_conflict');
      err.status = 409;
      throw err;
    }
    return { ...p, edits, version: (p.version ?? 1) + 1 };
  };
  const out = await autoApplyEbayResolutions([verifiedResult()], groups, putProduct);
  assert.equal(out.applied, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.perGroup[0].failed, 1);
  assert.match(out.perGroup[0].warning, /409/);
  assert.equal(products[0].edits.ebayCategoryId, '19591');
  assert.equal(products[1].edits.ebayCategoryId, undefined);
});

test('v9.3 (b): mã AI đoán (verifiedFromEbay=false) → KHÔNG gọi PUT, mã không lưu', async () => {
  const products = makeProducts();
  const groups = [{ key: 'lighting', label: 'Lighting', products }];
  const calls = [];
  const putProduct = async (p, edits) => { calls.push(p.id); return p; };
  // Mã AI đoán: có categoryId nhưng không có cờ verified.
  const guessed = { groupKey: 'lighting', categoryId: '12345', categoryName: 'Lamps', verifiedFromEbay: false };
  const out = await autoApplyEbayResolutions([guessed], groups, putProduct);
  assert.equal(calls.length, 0, 'mã chưa xác minh không được PUT');
  assert.equal(out.applied, 0);
  assert.equal(out.skipped, 1);
  // Nhóm không tra được mã cũng không PUT.
  const out2 = await autoApplyEbayResolutions(
    [{ groupKey: 'lighting', categoryId: null, warning: 'eBay không gợi ý được' }], groups, putProduct);
  assert.equal(calls.length, 0);
  assert.equal(out2.applied, 0);
  // Gợi ý danh mục của AI (draftCategorySuggestion) KHÔNG BAO GIỜ thành
  // mã danh mục đã xác minh: resolvedCategoryFromEdits bỏ qua nó.
  assert.equal(resolvedCategoryFromEdits({
    draftCategorySuggestion: { suggestedCategory: 'Lamps', unverified: true },
  }), null);
  assert.equal(resolvedCategoryFromEdits({ ebayCategoryId: '19591', ebayCategoryName: 'Lighting Kits' }).verifiedFromEbay, true);
});

test('v9.3 (c): danh sách "Đã cào được" đủ 13 dòng (v9.5 thêm Bóng đèn + Chăm sóc), trường thiếu hiện "chưa có", không bịa', () => {
  const [full] = makeProducts();
  full.ebayItemTitle = 'Daxton Square Cushion — Soho Home';
  full.ebayItemUrl = 'https://www.ebay.com/itm/123456789012';
  full.ebayMatchScore = 0.87;
  full.ebaySold = 1234;
  full.ebayWatchers = 87;
  full.edits = { ebayCategoryId: '19591', ebayCategoryName: 'Lighting Kits' };
  const items = crawledSummaryItems(full, { markupPct: 0.35, ebayFeePct: 0.13, shippingCost: 0, taxPct: 0 });
  assert.equal(items.length, 13);
  const byLabel = new Map(items.map((it) => [it.label, it]));
  assert.equal(byLabel.get('Tiêu đề').value, 'Daxton Square Cushion');
  assert.match(byLabel.get('Giá').value, /^\$280\.00/);
  assert.equal(byLabel.get('Ảnh').value, '2 ảnh');
  assert.match(byLabel.get('Mô tả').value, /^có — \d+ ký tự$/);
  assert.equal(byLabel.get('Chất liệu').value, 'Linen');
  assert.equal(byLabel.get('Kích thước').value, '20 x 20 in');
  // Gối không có thông số bóng/chăm sóc -> "chưa có", không bịa.
  assert.equal(byLabel.get('Bóng đèn').value, 'chưa có');
  assert.equal(byLabel.get('Chăm sóc').value, 'chưa có');
  assert.match(byLabel.get('Biến thể').value, /20 x 20 in \/ Olive — \$280\.00/);
  assert.match(byLabel.get('Biến thể').value, /20 x 20 in \/ Rust — \$280\.00 \(Hết\)/);
  assert.equal(byLabel.get('Listing eBay khớp').value, 'Daxton Square Cushion — Soho Home (khớp 0.87)');
  assert.equal(byLabel.get('Listing eBay khớp').url, 'https://www.ebay.com/itm/123456789012');
  assert.equal(byLabel.get('Đã bán (eBay)').value, '~1234 (ước tính)');
  assert.equal(byLabel.get('Người theo dõi').value, '87');
  assert.equal(byLabel.get('Mã danh mục').value, '19591 — Lighting Kits (tự áp từ eBay)');

  // Sản phẩm thiếu trường: không bịa giá trị nào.
  const thin = { id: 'p9', title: 'Mystery Item', price: null, images: [], variants: [], version: 1, edits: {} };
  const thinItems = crawledSummaryItems(thin, {});
  const thinByLabel = new Map(thinItems.map((it) => [it.label, it]));
  assert.equal(thinByLabel.get('Giá').value, 'chưa có');
  assert.equal(thinByLabel.get('Ảnh').value, 'chưa có');
  assert.equal(thinByLabel.get('Mô tả').value, 'chưa có');
  assert.equal(thinByLabel.get('Chất liệu').value, 'chưa có');
  assert.equal(thinByLabel.get('Kích thước').value, 'chưa có');
  assert.equal(thinByLabel.get('Bóng đèn').value, 'chưa có');
  assert.equal(thinByLabel.get('Chăm sóc').value, 'chưa có');
  assert.equal(thinByLabel.get('Biến thể').value, 'chưa có');
  assert.equal(thinByLabel.get('Listing eBay khớp').value, 'chưa có');
  assert.equal(thinByLabel.get('Đã bán (eBay)').value, 'chưa có');
  assert.equal(thinByLabel.get('Người theo dõi').value, 'chưa có');
  assert.equal(thinByLabel.get('Mã danh mục').value, 'chưa có');
  // Web dùng đúng helper này để vẽ chi tiết sản phẩm.
  assert.ok(appJs().includes('crawledSummaryItems'), 'app.js dùng crawledSummaryItems');
  assert.ok(appJs().includes('Đã cào được'), 'chi tiết sản phẩm có tiêu đề "Đã cào được"');
});

test('v9.3 (d): nhóm tra mã thất bại → nút "Tìm lại", bấm lại thì tự áp khi tra được; xuất CSV tự tra mã trước', async () => {
  const js = appJs();
  // Bảng tóm tắt nhóm: nhóm chưa có mã chỉ còn nút "Tìm lại".
  assert.ok(js.includes('>Tìm lại</button>'), 'bảng tóm tắt có nút "Tìm lại" cho nhóm chưa có mã');
  assert.ok(js.includes('Tìm lại mã eBay cho nhóm chưa có mã'), 'có nút tìm lại cho tất cả nhóm chưa có mã');
  assert.ok(js.includes('Mã tra được tự áp luôn vào sản phẩm'), 'ghi rõ mã tự áp, không cần bấm gì thêm');
  // "Tìm lại" chạy lại resolveEbayGroups cho đúng nhóm đó.
  assert.ok(js.includes("data-resolve-ebay"), 'nút Tìm lại mang data-resolve-ebay');
  // Luồng xuất: AI phân loại → tự tra mã + tự áp → mới xây file CSV.
  const resolveIdx = js.indexOf('await resolveEbayGroups(groups, { refreshSummary: false })');
  const buildIdx = js.indexOf('buildGroupedEbayCsvs(state.products, template, currentExportConfig(), groups)');
  assert.ok(resolveIdx > 0, 'luồng xuất gọi resolveEbayGroups');
  assert.ok(buildIdx > resolveIdx, 'tự tra mã + tự áp xong mới xây file CSV');
  // Chạy lại: lần 1 không tra được mã → không áp; lần 2 tra được → tự áp.
  const products = makeProducts();
  const groups = [{ key: 'lighting', label: 'Lighting', products }];
  const calls = [];
  const putProduct = async (p, edits) => { calls.push(p.id); return { ...p, edits, version: (p.version ?? 1) + 1 }; };
  const first = await autoApplyEbayResolutions(
    [{ groupKey: 'lighting', categoryId: null, warning: 'eBay không gợi ý được' }], groups, putProduct);
  assert.equal(first.applied, 0);
  assert.equal(calls.length, 0);
  const second = await autoApplyEbayResolutions([verifiedResult()], groups, putProduct);
  assert.equal(second.applied, 2);
  assert.equal(calls.length, 2);
  assert.equal(products[0].edits.ebayCategoryId, '19591');
});
