// tests/ebay-browse.test.mjs — eBay Browse API (v9.1): tự động tìm listing
// eBay khớp + lấy số liệu BÁN/XEM, không nhập tay link hay số.
// KHÔNG gọi eBay thật trong test — mock fetch (token + search + getItem)
// như tests/ebay-taxonomy.test.mjs. Không có key thật trong file này.
// Kiểm tra: search trả 3 ứng viên -> khớp đúng listing giống nhất + giá
// gần nhất; không ứng viên nào đạt ngưỡng 0,50 -> không gán + warning;
// getItem trả watchCount + estimatedSoldQuantity -> lưu đúng vào product;
// enrich tự chạy sau extract-page; 429 ở bulk enrich thì dừng
// (stopped429); không có chuỗi watchcount.com trong code; chưa có khóa
// eBay -> 400 ebay_not_configured; sửa tay mã item -> lấy thẳng listing
// đó qua get_item_by_legacy_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeRecord } from '../public/core.js';
import { EbayTaxonomyRuntime } from '../server/ebay-taxonomy.mjs';
import {
  EbayBrowseRuntime, scoreEbayMatch, buildSearchQuery, EBAY_MATCH_MIN_SCORE,
} from '../server/ebay-browse.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const okJson = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Khóa GIẢ dùng trong test — không phải khóa thật, không dùng được với eBay.
const FAKE_APP_ID = 'test-app-id';
const FAKE_CERT_ID = 'test-cert-id';

/** Mock fetch cho toàn bộ eBay Browse: token + search + getItem. */
function makeBrowseFetch({ rateLimitOnSearchAfter = null } = {}) {
  const calls = [];
  let searchCount = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/identity/v1/oauth2/token') {
      return okJson(200, { access_token: 'mock-token-browse', expires_in: 7200 });
    }
    if (u.pathname.endsWith('/item_summary/search')) {
      searchCount++;
      if (rateLimitOnSearchAfter != null && searchCount > rateLimitOnSearchAfter) {
        return okJson(429, { errors: [{ message: 'Rate limit exceeded' }] });
      }
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      if (q.includes('daxton')) {
        return okJson(200, {
          itemSummaries: [
            { itemId: 'v1|111111111111|0', legacyItemId: '111111111111', title: 'Soho Home Halsey Square Cushion', price: { value: '380.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' },
            { itemId: 'v1|222222222222|0', legacyItemId: '222222222222', title: 'Soho Home Daxton Square Cushion', price: { value: '395.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/222222222222' },
            { itemId: 'v1|333333333333|0', legacyItemId: '333333333333', title: 'Soho Home Daxton Square Cushion Olive Linen', price: { value: '280.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/333333333333' },
          ],
          total: 3,
        });
      }
      if (q.includes('zebra') || q.includes('xyzzy')) {
        return okJson(200, {
          itemSummaries: [
            { itemId: 'v1|444444444444|0', legacyItemId: '444444444444', title: 'Soho Home Halsey Square Cushion', price: { value: '380.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/444444444444' },
            { itemId: 'v1|555555555555|0', legacyItemId: '555555555555', title: 'Soho Home Renato Wall Light', price: { value: '245.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/555555555555' },
          ],
          total: 2,
        });
      }
      return okJson(200, { itemSummaries: [], total: 0 });
    }
    if (u.pathname.includes('/item/get_item_by_legacy_id')) {
      const id = u.searchParams.get('legacy_item_id');
      return okJson(200, {
        itemId: `v1|${id}|0`, legacyItemId: id, title: 'Soho Home Daxton Square Cushion Olive Linen',
        price: { value: '280.00', currency: 'USD' }, watchCount: 87,
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedSoldQuantity: 1234, estimatedRemainingQuantity: 12 }],
        itemWebUrl: `https://www.ebay.com/itm/${id}`,
      });
    }
    if (u.pathname.includes('/buy/browse/v1/item/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      const map = {
        'v1|333333333333|0': { title: 'Soho Home Daxton Square Cushion Olive Linen', price: '280.00', watchCount: 87, sold: 1234, remaining: 12 },
        'v1|222222222222|0': { title: 'Soho Home Daxton Square Cushion', price: '395.00', watchCount: 41, sold: 512, remaining: 8 },
      };
      const m = map[id];
      if (!m) return okJson(404, {});
      return okJson(200, {
        itemId: id, legacyItemId: id.split('|')[1], title: m.title,
        price: { value: m.price, currency: 'USD' }, watchCount: m.watchCount,
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedSoldQuantity: m.sold, estimatedRemainingQuantity: m.remaining }],
        itemWebUrl: `https://www.ebay.com/itm/${id.split('|')[1]}`,
      });
    }
    return okJson(404, {});
  };
  fn.calls = calls;
  fn.searchCalls = () => calls.filter((c) => new URL(c.url).pathname.endsWith('/item_summary/search'));
  return fn;
}

function makeBrowseRuntime(fetchFn) {
  const taxonomy = new EbayTaxonomyRuntime({ EBAY_APP_ID: FAKE_APP_ID, EBAY_CERT_ID: FAKE_CERT_ID });
  taxonomy.fetchFn = fetchFn;
  return new EbayBrowseRuntime(taxonomy);
}

function makeProduct(overrides) {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: `https://www.sohohome.com/us/products/${overrides.id}`,
    source_product_id: overrides.id,
    brand: 'Soho Home',
    title: overrides.title,
    price: overrides.price ?? null,
    variants: [{ options: {}, price: overrides.price ?? null, in_stock: true }],
  });
  return product;
}

/** AI runtime giả: chưa cấu hình key -> extract-page dùng luật, không gọi LLM. */
const ruleBasedAiRuntime = {
  getStatus: () => ({ configured: false, provider: 'rule-based', model: null, source: 'none' }),
  callLlmJson: async () => { throw new Error('no key'); },
};

test('v9.1 (a): search 3 ứng viên -> khớp listing giống nhất + giá gần nhất', async () => {
  const fetchFn = makeBrowseFetch();
  const browse = makeBrowseRuntime(fetchFn);
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  const result = await browse.enrichProduct(product);
  assert.equal(result.matched, true);
  assert.equal(result.legacyItemId, '333333333333', 'khớp listing Olive Linen (đủ 4/4 từ khoá), không phải Halsey hay Daxton trơn');
  assert.equal(result.sold, 1234, 'số đã bán từ estimatedSoldQuantity');
  assert.equal(result.watchers, 87, 'số người theo dõi từ watchCount');
  assert.equal(result.score, 1);
  assert.equal(result.source, 'browse-api');
  // Search gửi kèm header marketplace EBAY-US (Browse API bắt buộc).
  const searchInit = fetchFn.searchCalls()[0].init;
  assert.equal(searchInit.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
});

test('v9.1 (a2): scoreEbayMatch — trùng từ chung chung không đủ để khớp', () => {
  const daxton = { title: 'Soho Home Daxton Square Cushion', price: 395 };
  const halsey = { title: 'Soho Home Halsey Square Cushion', price: { value: 380 } };
  assert.equal(scoreEbayMatch(daxton, halsey), 0, 'trùng "Square Cushion" nhưng khác từ phân biệt Daxton -> 0');
  assert.equal(scoreEbayMatch(daxton, { title: 'Soho Home Daxton Square Cushion', price: { value: 395 } }), 1);
  assert.equal(buildSearchQuery('Soho Home Daxton Square Cushion Olive'), 'daxton square cushion olive');
  assert.equal(EBAY_MATCH_MIN_SCORE, 0.5);
});

test('v9.1 (b): không ứng viên nào đạt ngưỡng -> không gán, có warning', async () => {
  const browse = makeBrowseRuntime(makeBrowseFetch());
  const product = makeProduct({ id: 'zebra-xyzzy-table', title: 'Soho Home Zebra Xyzzy Table', price: 100 });
  const result = await browse.enrichProduct(product);
  assert.equal(result.matched, false);
  assert.match(result.warning, /không có listing nào khớp đủ/);
  assert.equal(result.itemId, undefined);
});

test('v9.1 (c): POST /api/ebay/enrich lưu watchCount + estimatedSoldQuantity vào product', async () => {
  const store = new MemoryStore();
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  await store.putProduct(product);
  const browse = makeBrowseRuntime(makeBrowseFetch());
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/enrich',
    body: { productId: product.id },
  }, { browseRuntime: browse });
  assert.equal(status, 200);
  assert.equal(json.enrichment.matched, true);
  assert.equal(json.product.ebaySold, 1234);
  assert.equal(json.product.ebayWatchers, 87);
  assert.equal(json.product.ebayItemId, '333333333333');
  assert.equal(json.product.ebayItemTitle, 'Soho Home Daxton Square Cushion Olive Linen');
  assert.equal(json.product.ebayItemUrl, 'https://www.ebay.com/itm/333333333333');
  assert.equal(json.product.ebayMatchScore, 1);
  assert.equal(json.product.ebayMatchSource, 'browse-api');
  assert.equal(json.product.ebayWatchersSource, 'eBay Browse API (tự động)');
  // Đọc lại từ store: số liệu đã lưu bền, không chỉ nằm trong response.
  const reloaded = await store.getProduct(product.id);
  assert.equal(reloaded.ebaySold, 1234);
  assert.equal(reloaded.ebayWatchers, 87);
});

test('v9.1 (c2): chưa có khóa eBay -> enrich trả 400 ebay_not_configured', async () => {
  const store = new MemoryStore();
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  await store.putProduct(product);
  const noKeyTaxonomy = new EbayTaxonomyRuntime({});
  const browse = new EbayBrowseRuntime(noKeyTaxonomy);
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/enrich',
    body: { productId: product.id },
  }, { browseRuntime: browse });
  assert.equal(status, 400);
  assert.equal(json.error, 'ebay_not_configured');
});

test('v9.1 (c3): sửa tay mã item -> lấy thẳng listing đó qua get_item_by_legacy_id', async () => {
  const store = new MemoryStore();
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  await store.putProduct(product);
  const fetchFn = makeBrowseFetch();
  const browse = makeBrowseRuntime(fetchFn);
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/enrich',
    body: { productId: product.id, ebayItemId: '333333333333' },
  }, { browseRuntime: browse });
  assert.equal(status, 200);
  assert.equal(json.enrichment.matched, true);
  assert.equal(json.enrichment.score, 1, 'chỉ định thẳng thì điểm khớp = 1');
  assert.equal(json.product.ebaySold, 1234);
  assert.equal(json.product.ebayWatchers, 87);
  assert.ok(fetchFn.calls.some((c) => new URL(c.url).pathname.includes('/item/get_item_by_legacy_id')), 'gọi get_item_by_legacy_id cho mã số');
});

test('v9.1 (d): enrich tự chạy sau extract-page (không cần dán link/số)', async () => {
  const store = new MemoryStore();
  const browse = makeBrowseRuntime(makeBrowseFetch());
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/extract-page',
    body: {
      url: 'https://www.sohohome.com/us/products/daxton-square-cushion-olive/79996850',
      raw: {
        title: 'Soho Home Daxton Square Cushion Olive', price: 395, currency: 'USD',
        images: ['https://assets.sohohome.com/x.jpg'], description: 'Square cushion, olive.',
        variants: [{ options: { Color: 'Olive' }, price: 395, in_stock: true }],
      },
    },
  }, { aiRuntime: ruleBasedAiRuntime, browseRuntime: browse });
  assert.equal(status, 200);
  assert.equal(json.enrichment.matched, true, 'extract-page xong là listing eBay đã khớp ngay');
  assert.equal(json.product.ebaySold, 1234);
  assert.equal(json.product.ebayWatchers, 87);
  assert.equal(json.product.ebayItemId, '333333333333');
});

test('v9.1 (e): 429 ở bulk enrich thì dừng, stopped429, giữ kết quả đã làm xong', async () => {
  const store = new MemoryStore();
  const p1 = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  const p2 = makeProduct({ id: 'daxton-square-cushion', title: 'Soho Home Daxton Square Cushion', price: 395 });
  await store.putProduct(p1);
  await store.putProduct(p2);
  const browse = makeBrowseRuntime(makeBrowseFetch({ rateLimitOnSearchAfter: 1 }));
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/enrich-all', body: {},
  }, { browseRuntime: browse });
  assert.equal(status, 200);
  assert.equal(json.stopped429, true);
  assert.equal(json.results.length, 2, 'sản phẩm thứ 2 đã thử và dính 429 nên vẫn có kết quả');
  assert.equal(json.results[0].matched, true, 'sản phẩm đầu khớp xong trước khi dừng');
  assert.equal(json.results[1].matched, false);
  assert.match(json.results[1].warning, /429/);
  const reloaded1 = await store.getProduct(p1.id);
  assert.equal(reloaded1.ebaySold, 1234, 'sản phẩm đã khớp vẫn được lưu dù bulk dừng giữa chừng');
});

// ---- (f) KHÔNG có chuỗi watchcount.com trong code ----------------------------
// Browse API thay hoàn toàn đường lấy số liệu: không fetch/cào watchcount
// (robots.txt cấm bot, không có API công khai). Quét server/, public/,
// extension/src/ — file test này được loại trừ vì nó chứa chuỗi cần tìm.
test('v9.1 (f): không có chuỗi watchcount.com trong code (server/public/extension)', () => {
  const roots = ['server', 'public', 'extension/src'];
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|js|html|css|json)$/.test(entry)) continue;
      const content = readFileSync(full, 'utf-8');
      if (/watchcount\.com/i.test(content)) bad.push(full);
      if (/fetch\s*\(\s*['"`][^'"`]*watchcount/i.test(content)) bad.push(`${full} (fetch)`);
    }
  };
  for (const r of roots) walk(path.join(root, r));
  assert.deepEqual(bad, [], 'code không được chứa domain watchcount (không fetch, không cào)');
});

// ---- Cache Browse (25/11/2026): TTL, tách theo marketplace, "Tìm lại" tra lại eBay ----

test('cache Browse: cùng marketplace dùng cache; fresh và đổi marketplace thì gọi lại eBay', async () => {
  const fetchFn = makeBrowseFetch();
  const browse = makeBrowseRuntime(fetchFn);
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  await browse.enrichProduct(product);
  await browse.enrichProduct(product);
  assert.equal(fetchFn.searchCalls().length, 1, 'lần 2 dùng cache');
  await browse.enrichProduct(product, { fresh: true });
  assert.equal(fetchFn.searchCalls().length, 2, 'fresh (nút Tìm lại) bỏ qua cache');
  browse.taxonomy.memory.marketplaceId = 'EBAY_GB';
  await browse.enrichProduct(product);
  assert.equal(fetchFn.searchCalls().length, 3, 'đổi marketplace không dùng kết quả của EBAY_US');
});

test('cache Browse: hết hạn sau EBAY_BROWSE_CACHE_TTL_MS', async () => {
  const { EBAY_BROWSE_CACHE_TTL_MS } = await import('../server/ebay-browse.mjs');
  const fetchFn = makeBrowseFetch();
  const browse = makeBrowseRuntime(fetchFn);
  await browse.searchItemsByTitle('Soho Home Daxton Square Cushion');
  for (const entry of browse.searchCache.values()) entry.at -= EBAY_BROWSE_CACHE_TTL_MS + 1;
  await browse.searchItemsByTitle('Soho Home Daxton Square Cushion');
  assert.equal(fetchFn.searchCalls().length, 2, 'cache quá hạn thì tra lại');
});

test('POST /api/ebay/enrich ("Tìm lại") luôn tra lại eBay, không trả số cũ trong cache', async () => {
  const fetchFn = makeBrowseFetch();
  const browse = makeBrowseRuntime(fetchFn);
  const store = new MemoryStore();
  const product = makeProduct({ id: 'daxton-square-cushion-olive', title: 'Soho Home Daxton Square Cushion Olive', price: 395 });
  store.putProduct(product);
  for (let i = 0; i < 2; i++) {
    const res = await handleRequest(store, { method: 'POST', path: '/api/ebay/enrich', bodyText: JSON.stringify({ productId: product.id }) }, { browseRuntime: browse });
    assert.equal(res.status, 200);
  }
  assert.equal(fetchFn.searchCalls().length, 2);
});
