// tests/ebay-taxonomy.test.mjs — eBay Taxonomy API (v8): tra mã danh mục
// thật từ eBay thay vì user tải template từng danh mục hay nhớ mã.
// KHÔNG gọi eBay thật trong test — mock fetch (token + taxonomy) như
// tests/ai-group.test.mjs. Không có key thật trong file này — chỉ khóa giả
// 'test-app-id' / 'test-cert-id' và token giả 'mock-token-*'.
// Kiểm tra: token + cache + tự làm mới khi hết hạn, token lỗi -> lỗi rõ
// không crash, getCategorySuggestions chỉ nhận leaf, resolve-groups cho 3
// nhóm mẫu, getItemAspects trả required aspects, xuất CSV upload được cho
// nhóm có mã Taxonomy, mã do AI đoán KHÔNG lọt vào cột Category, không có
// khóa eBay -> fallback file nháp như v7, khóa không lộ trong
// response/status/log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseEbayTemplate, normalizeRecord, parseCsvText, templateColumnIndex,
  groupProductsByTheme, groupProductsByAiAssignments, buildGroupedEbayCsvs,
  buildEbayTemplateCsv, buildDraftGroupedCsvs, autoSheetToCsv, resolvedCategoryFromEdits,
  applyTaxonomyResolutions, resolvedTypeValues, mapResolvedCategoryType, matchTypeValue,
} from '../public/core.js';
import {
  EbayTaxonomyRuntime, EbayTaxonomyError, buildGroupQuery,
} from '../server/ebay-taxonomy.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const template = parseEbayTemplate(readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8'));
const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };
const okJson = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Khóa GIẢ dùng trong test — không phải khóa thật, không dùng được với eBay.
const FAKE_APP_ID = 'test-app-id';
const FAKE_CERT_ID = 'test-cert-id';

/** Mock fetch cho toàn bộ eBay: token + taxonomy. Ghi lại mọi lần gọi. */
function makeEbayFetch({ tokenFail = false, suggestions401Once = false } = {}) {
  const calls = [];
  let tokenCount = 0;
  let suggestions401Done = false;
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/identity/v1/oauth2/token') {
      tokenCount++;
      if (tokenFail) return okJson(401, { error: 'invalid_client', error_description: 'Invalid client credentials' });
      return okJson(200, { access_token: `mock-token-${tokenCount}`, token_type: 'Bearer', expires_in: 7200 });
    }
    if (u.pathname.endsWith('/get_default_category_tree_id')) {
      return okJson(200, { categoryTreeId: '0' });
    }
    if (u.pathname.endsWith('/get_category_suggestions')) {
      if (suggestions401Once && !suggestions401Done) {
        suggestions401Done = true;
        return okJson(401, { errors: [{ message: 'Invalid access token' }] });
      }
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      if (q.includes('table lamp')) {
        return okJson(200, {
          categorySuggestions: [
            { category: { categoryId: '177913', categoryName: 'Table Lamps' }, categoryTreeNodePath: 'Home & Garden > Lamps > Table Lamps', leafCategoryTreeNode: true },
            { category: { categoryId: '177000', categoryName: 'Lamps' }, categoryTreeNodePath: 'Home & Garden > Lamps', leafCategoryTreeNode: false },
          ],
        });
      }
      if (q.includes('wall mirror')) {
        return okJson(200, {
          categorySuggestions: [
            { category: { categoryId: '177915', categoryName: 'Wall Mirrors' }, categoryTreeNodePath: 'Home & Garden > Mirrors > Wall Mirrors', leafCategoryTreeNode: true },
          ],
        });
      }
      return okJson(200, { categorySuggestions: [] });
    }
    if (u.pathname.endsWith('/get_category_subtree')) {
      return okJson(200, { categoryTreeId: '0', categoryTreeVersion: '2026-11', categorySubtreeNode: { category: { categoryId: u.searchParams.get('category_id'), categoryName: 'Table Lamps' }, categoryTreeNodeLevel: 3, leafCategoryTreeNode: true } });
    }
    if (u.pathname.endsWith('/get_item_aspects_for_category')) {
      const id = u.searchParams.get('category_id');
      if (id === '177913') {
        return okJson(200, {
          aspects: [
            { localizedAspectName: 'Type', aspectConstraint: { aspectRequired: true }, aspectValues: [{ localizedValue: 'Table Lamp' }] },
            { localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true }, aspectValues: [] },
            { localizedAspectName: 'Bulb Type', aspectConstraint: { aspectRequired: false }, aspectValues: [{ localizedValue: 'LED' }] },
            { localizedAspectName: 'Material', aspectConstraint: { aspectRequired: false }, aspectValues: [] },
          ],
        });
      }
      if (id === '177915') {
        return okJson(200, {
          aspects: [
            { localizedAspectName: 'Type', aspectConstraint: { aspectRequired: true }, aspectValues: [{ localizedValue: 'Wall Mirror' }] },
            { localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true }, aspectValues: [] },
          ],
        });
      }
      return okJson(200, { aspects: [] });
    }
    return okJson(404, {});
  };
  fn.calls = calls;
  fn.tokenCount = () => tokenCount;
  fn.tokenCalls = () => calls.filter((c) => new URL(c.url).pathname === '/identity/v1/oauth2/token');
  return fn;
}

function makeRuntime(fetchFn) {
  const rt = new EbayTaxonomyRuntime({ EBAY_APP_ID: FAKE_APP_ID, EBAY_CERT_ID: FAKE_CERT_ID });
  rt.fetchFn = fetchFn;
  return rt;
}

function makeProduct(overrides) {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: `https://www.sohohome.com/us/products/${overrides.id}`,
    source_product_id: overrides.id,
    brand: 'Soho Home',
    title: overrides.title,
    description_text: overrides.description ?? '',
    images: ['https://assets.sohohome.com/x.jpg'],
    specs: overrides.specs ?? {},
    variants: [{ options: {}, price: overrides.price ?? 300, in_stock: true }],
  });
  if (overrides.edits) product.edits = { ...(product.edits ?? {}), ...overrides.edits };
  return product;
}

const cushion = () => makeProduct({ id: 'daxton-square-cushion', title: 'Soho Home Daxton Square Cushion', description: 'Square cushion woven in Italy from jacquard with a feather inner pad.', specs: { Material: 'Viscose jacquard' } });
const lamp = () => makeProduct({ id: 'archie-table-lamp', title: 'Soho Home Archie Table Lamp', description: 'Table lamp with linen shade and brass base.', specs: { Type: 'Table Lamp', 'Bulb Type': 'LED', Material: 'Brass' } });
const mirror = () => makeProduct({ id: 'betty-mirror-short', title: 'Soho Home Betty Wall Mirror, Antique Brass', description: 'Wall mirror with antique brass frame.', specs: { Type: 'Wall Mirror' } });

/** Lấy dòng sản phẩm đầu tiên trong CSV file Exchange (dòng 41, sau Info). */
function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { headers: rows[1], row: rows[firstDataIdx], rowCount: rows.length - firstDataIdx };
}

// ---- Token: lấy + cache + tự làm mới khi hết hạn ---------------------------

test('lấy application token: gọi 1 lần rồi cache trong RAM, lần sau không gọi lại', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const t1 = await rt.getApplicationToken();
  const t2 = await rt.getApplicationToken();
  assert.equal(t1, 'mock-token-1');
  assert.equal(t2, 'mock-token-1');
  assert.equal(fetchFn.tokenCount(), 1, 'token chỉ gọi 1 lần, lần sau dùng cache');
  // Token gửi qua Basic auth App ID + Cert ID (không lộ trong response).
  const auth = fetchFn.tokenCalls()[0].init.headers.Authorization;
  assert.ok(auth.startsWith('Basic '));
  assert.equal(Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf-8'), `${FAKE_APP_ID}:${FAKE_CERT_ID}`);
});

test('token hết hạn: tự làm mới (lấy token mới), không crash', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  assert.equal(await rt.getApplicationToken(), 'mock-token-1');
  rt.tokenCache.expiresAt = Date.now() - 1; // giả lập token đã hết hạn
  assert.equal(await rt.getApplicationToken(), 'mock-token-2');
  assert.equal(fetchFn.tokenCount(), 2);
});

test('token lỗi (401, khóa sai): lỗi rõ ebay_auth_failed, không crash route', async () => {
  const fetchFn = makeEbayFetch({ tokenFail: true });
  const rt = makeRuntime(fetchFn);
  await assert.rejects(
    () => rt.getApplicationToken(),
    (e) => e instanceof EbayTaxonomyError && e.code === 'ebay_auth_failed',
  );
});

test('chưa có khóa eBay: getApplicationToken báo ebay_not_configured', async () => {
  const rt = new EbayTaxonomyRuntime({});
  rt.fetchFn = makeEbayFetch();
  await assert.rejects(
    () => rt.getApplicationToken(),
    (e) => e instanceof EbayTaxonomyError && e.code === 'ebay_not_configured',
  );
});

// ---- getCategorySuggestions: chỉ nhận leaf ---------------------------------

test('getCategorySuggestions chỉ nhận leaf: gợi ý "Lamps" không phải leaf bị bỏ', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const suggestions = await rt.getCategorySuggestions('Table Lamps');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, '177913');
  assert.equal(suggestions[0].name, 'Table Lamps');
  assert.equal(suggestions[0].leaf, true);
  assert.match(suggestions[0].path, /Table Lamps/);
});

test('getCategorySuggestions cache theo từ khoá: gọi 2 lần, eBay chỉ gọi 1 lần', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  await rt.getCategorySuggestions('Table Lamps');
  await rt.getCategorySuggestions('Table Lamps');
  const n = fetchFn.calls.filter((c) => new URL(c.url).pathname.endsWith('/get_category_suggestions')).length;
  assert.equal(n, 1);
});

test('401 giữa chừng (token hết hạn): làm mới token 1 lần rồi thử lại, vẫn lấy được gợi ý', async () => {
  const fetchFn = makeEbayFetch({ suggestions401Once: true });
  const rt = makeRuntime(fetchFn);
  const suggestions = await rt.getCategorySuggestions('Wall Mirrors');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, '177915');
  assert.equal(fetchFn.tokenCount(), 2, 'token được làm mới 1 lần sau 401');
});

// ---- getItemAspects ----------------------------------------------------------

test('getItemAspects trả required/recommended aspects của danh mục', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const { requiredAspects, recommendedAspects } = await rt.getItemAspects('177913');
  assert.deepEqual(requiredAspects.map((a) => a.name), ['Type', 'Brand']);
  assert.deepEqual(recommendedAspects.map((a) => a.name), ['Bulb Type', 'Material']);
  assert.deepEqual(requiredAspects[0].values, ['Table Lamp']);
});

test('getItemAspects preserves complete constraints and all values, including conditional values after index 100', async () => {
  const fallbackFetch = makeEbayFetch();
  const constraint = {
    aspectRequired: true, aspectUsage: 'RECOMMENDED', aspectMode: 'SELECTION_ONLY',
    aspectDataType: 'STRING', itemToAspectCardinality: 'MULTI', aspectMaxLength: 65,
    aspectEnabledForVariations: false, expectedRequiredByDate: '2027-01-01',
    aspectApplicableTo: ['ITEM'], aspectFormat: 'custom-format',
  };
  const aspectValues = Array.from({ length: 125 }, (_, i) => ({ localizedValue: `Brand ${i}` }));
  aspectValues[124].valueConstraints = [{ applicableForLocalizedAspectName: 'Type', applicableForLocalizedAspectValues: ['Table Lamp'] }];
  const rt = makeRuntime(async (url, init) => new URL(url).pathname.endsWith('/get_item_aspects_for_category')
    ? okJson(200, { aspects: [
      { localizedAspectName: 'Brand', aspectConstraint: constraint, aspectValues },
      { localizedAspectName: 'Color', aspectConstraint: { aspectRequired: false, aspectUsage: 'RECOMMENDED', aspectMode: 'FREE_TEXT' }, aspectValues: [{ localizedValue: 'Blue' }] },
    ] }) : fallbackFetch(url, init));
  const result = await rt.getItemAspects('177913');
  assert.equal(result.requiredAspects.length, 1);
  assert.deepEqual(result.requiredAspects[0].aspectConstraint, constraint);
  assert.equal(result.requiredAspects[0].values.length, 125);
  assert.equal(result.requiredAspects[0].values[124], 'Brand 124');
  assert.deepEqual(result.requiredAspects[0].aspectValues, aspectValues);
  assert.equal(result.recommendedAspects[0].aspectConstraint.aspectMode, 'FREE_TEXT');
});

test('getCategorySuggestions builds ancestry from official parent-to-root references', async () => {
  const fallbackFetch = makeEbayFetch();
  const rt = makeRuntime(async (url, init) => new URL(url).pathname.endsWith('/get_category_suggestions')
    ? okJson(200, { categorySuggestions: [{
      category: { categoryId: '177913', categoryName: 'Table Lamps' },
      categoryTreeNodeAncestors: [
        { categoryId: '11', categoryName: 'Lamps', categoryTreeNodeLevel: 2 },
        { categoryId: '12', categoryName: 'Home & Garden', categoryTreeNodeLevel: 1 },
        { categoryId: '0', categoryName: 'Random root name', categoryTreeNodeLevel: 0 },
      ],
    }] }) : fallbackFetch(url, init));
  const [suggestion] = await rt.getCategorySuggestions('Table Lamps');
  assert.equal(suggestion.path, 'Home & Garden > Lamps > Table Lamps');
  const details = await rt.getCategoryDetails('177913');
  assert.equal(details.categoryPath, suggestion.path);
  assert.equal(details.categoryPathComplete, true);
});

test('getCategoryDetails validates exact leaf ID and obtains schema without keyword guessing', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const details = await rt.getCategoryDetails(' 177913 ');
  assert.equal(details.categoryId, '177913');
  assert.equal(details.categoryName, 'Table Lamps');
  assert.equal(details.categoryPath, 'Table Lamps');
  assert.equal(details.categoryPathComplete, false, 'subtree does not include full ancestry');
  assert.equal(details.categoryTreeId, '0');
  assert.equal(details.categoryTreeVersion, '2026-11');
  assert.equal(details.marketplace, 'EBAY_US');
  assert.equal(details.verifiedFromEbay, true);
  assert.deepEqual(details.requiredAspects.map((a) => a.name), ['Type', 'Brand']);
  assert.ok(!fetchFn.calls.some((c) => c.url.includes('get_category_suggestions')));
  await rt.getCategoryDetails('177913');
  assert.equal(fetchFn.calls.filter((c) => c.url.includes('get_category_subtree')).length, 1);
  assert.equal(fetchFn.calls.filter((c) => c.url.includes('get_item_aspects_for_category')).length, 1);
});

test('getCategoryDetails rejects malformed IDs, mismatched nodes and non-leaf categories', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  for (const id of ['', '../177913', '1&category_id=2', '0', -1]) {
    await assert.rejects(() => rt.getCategoryDetails(id), (e) => e.code === 'invalid_category_id');
  }
  assert.equal(fetchFn.calls.length, 0, 'invalid IDs do not call eBay');
  for (const node of [
    { category: { categoryId: '999', categoryName: 'Wrong category' }, leafCategoryTreeNode: true },
    { category: { categoryId: '177913', categoryName: 'Parent' }, childCategoryTreeNodes: [{ category: { categoryId: '1' } }] },
    { category: { categoryId: '177913', categoryName: 'Unknown leaf' }, childCategoryTreeNodes: [] },
  ]) {
    const mock = makeEbayFetch();
    const runtime = makeRuntime(async (url, init) => new URL(url).pathname.endsWith('/get_category_subtree')
      ? okJson(200, { categorySubtreeNode: node }) : mock(url, init));
    await assert.rejects(() => runtime.getCategoryDetails('177913'), (e) => ['ebay_api_error', 'ebay_category_not_leaf'].includes(e.code));
    assert.ok(!mock.calls.some((c) => c.url.includes('get_item_aspects_for_category')));
  }
});

test('Taxonomy metadata cache does not mix marketplace or environment schemas for the same category ID', async () => {
  const fallbackFetch = makeEbayFetch();
  let aspectCalls = 0;
  const rt = makeRuntime(async (url, init) => {
    if (new URL(url).pathname.endsWith('/get_item_aspects_for_category')) {
      aspectCalls++;
      return okJson(200, { aspects: [{ localizedAspectName: `Schema ${aspectCalls}`, aspectConstraint: { aspectRequired: true } }] });
    }
    return fallbackFetch(url, init);
  });
  assert.equal((await rt.getItemAspects('177913')).requiredAspects[0].name, 'Schema 1');
  rt.setMemoryConfig({ marketplaceId: 'EBAY-GB' });
  assert.equal((await rt.getItemAspects('177913')).requiredAspects[0].name, 'Schema 2');
  rt.setMemoryConfig({ environment: 'sandbox' });
  assert.equal((await rt.getItemAspects('177913')).requiredAspects[0].name, 'Schema 3');
});

// ---- resolve-groups: 3 nhóm mẫu ----------------------------------------------

test('resolve-groups: đèn bàn và gương tra được mã giả lập (verifiedFromEbay), nhóm lạ -> null + warning', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const { results, warnings } = await rt.resolveGroups([
    { groupKey: 'table-lamps', label: 'Table Lamps', sampleTitles: ['Soho Home Archie Table Lamp', 'Soho Home Renato Table Lamp'] },
    { groupKey: 'wall-mirrors', label: 'Wall Mirrors', sampleTitles: ['Soho Home Betty Wall Mirror'] },
    { groupKey: 'nhom-la', label: 'Nhóm lạ Xyzzy', sampleTitles: ['Soho Home Xyzzy Thing'] },
  ]);
  assert.equal(results.length, 3);
  const lamps = results.find((r) => r.groupKey === 'table-lamps');
  assert.equal(lamps.categoryId, '177913');
  assert.equal(lamps.categoryName, 'Table Lamps');
  assert.equal(lamps.verifiedFromEbay, true);
  assert.deepEqual(lamps.requiredAspects.map((a) => a.name), ['Type', 'Brand']);
  assert.equal(lamps.warning, null);
  const mirrors = results.find((r) => r.groupKey === 'wall-mirrors');
  assert.equal(mirrors.categoryId, '177915');
  assert.equal(mirrors.verifiedFromEbay, true);
  const strange = results.find((r) => r.groupKey === 'nhom-la');
  assert.equal(strange.categoryId, null);
  assert.equal(strange.verifiedFromEbay, false);
  assert.ok(strange.warning, 'nhóm lạ phải có warning');
  assert.ok(warnings.length >= 1);
});

// ---- v8.4 hồi quy: đường dẫn lấy trường phải là get_item_aspects_for_category ----
// Lỗi thật 16/11/2026: code gọi /get_item_aspects (đường dẫn này KHÔNG tồn
// tại trong Taxonomy API của eBay) nên eBay trả 404 cho mọi lần lấy trường →
// resolveGroups trả categoryId=null cho cả 7 nhóm dù kiểm tra kết nối
// (getDefaultCategoryTreeId, đường dẫn khác) vẫn OK. Mock cũ khớp bằng
// endsWith('/get_item_aspects') nên test vẫn xanh dù đường dẫn sai.
test('v8.4 hồi quy: resolveGroups gọi đúng /get_item_aspects_for_category, không gọi /get_item_aspects', async () => {
  const fetchFn = makeEbayFetch();
  const rt = makeRuntime(fetchFn);
  const { results } = await rt.resolveGroups([
    { groupKey: 'table-lamps', label: 'Table Lamps', sampleTitles: ['Soho Home Archie Table Lamp'] },
  ]);
  const lamps = results[0];
  assert.equal(lamps.categoryId, '177913');
  assert.equal(lamps.verifiedFromEbay, true);
  assert.deepEqual(lamps.requiredAspects.map((a) => a.name), ['Type', 'Brand']);
  const urls = fetchFn.calls.map((c) => new URL(c.url));
  const aspectsCalls = urls.filter((u) => u.pathname.endsWith('/get_item_aspects_for_category'));
  assert.equal(aspectsCalls.length, 1, 'chỉ 1 lần gọi lấy trường cho mã đã chọn');
  assert.equal(aspectsCalls[0].searchParams.get('category_id'), '177913');
  const wrongCalls = urls.filter((u) => u.pathname.endsWith('/get_item_aspects'));
  assert.equal(wrongCalls.length, 0, 'không được gọi đường dẫn /get_item_aspects (không tồn tại trong Taxonomy API)');
});

test('buildGroupQuery: label đọc được thì dùng thẳng, label slug thì lấy cụm loại trong tên mẫu', () => {
  assert.equal(buildGroupQuery('Table Lamps', ['Soho Home Archie Table Lamp']), 'Table Lamps');
  assert.equal(buildGroupQuery('table-lamps', ['Soho Home Archie Table Lamp']), 'Table Lamp');
  assert.equal(buildGroupQuery('wall-mirrors', ['Soho Home Betty Wall Mirror, Antique Brass']), 'Wall Mirror');
});

// ---- Endpoint API: status/config/check/resolve-groups -------------------------

test('endpoint /api/ebay/status + config: không trả key ra response, chỉ trả configured/environment', async () => {
  const store = new MemoryStore();
  const rt = new EbayTaxonomyRuntime({});
  rt.fetchFn = makeEbayFetch();
  const before = await handleRequest(store, { method: 'GET', path: '/api/ebay/status' }, { ebayRuntime: rt });
  assert.equal(before.status, 200);
  assert.equal(before.json.configured, false);
  assert.ok(!JSON.stringify(before.json).includes(FAKE_APP_ID), 'status không lộ App ID');
  const saved = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/config',
    body: { appId: FAKE_APP_ID, certId: FAKE_CERT_ID, environment: 'production' },
  }, { ebayRuntime: rt });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.configured, true);
  assert.equal(saved.json.environment, 'production');
  assert.ok(!JSON.stringify(saved.json).includes(FAKE_APP_ID), 'config response không lộ App ID');
  assert.ok(!JSON.stringify(saved.json).includes(FAKE_CERT_ID), 'config response không lộ Cert ID');
  const after = await handleRequest(store, { method: 'GET', path: '/api/ebay/status' }, { ebayRuntime: rt });
  assert.equal(after.json.configured, true);
  assert.ok(!JSON.stringify(after.json).includes(FAKE_CERT_ID), 'status không lộ Cert ID');
  const cleared = await handleRequest(store, { method: 'DELETE', path: '/api/ebay/config' }, { ebayRuntime: rt });
  assert.equal(cleared.json.configured, false);
});

test('endpoint /api/ebay/check: khóa đúng -> connected + tree id 0', async () => {
  const store = new MemoryStore();
  const rt = makeRuntime(makeEbayFetch());
  const res = await handleRequest(store, { method: 'GET', path: '/api/ebay/check' }, { ebayRuntime: rt });
  assert.equal(res.status, 200);
  assert.equal(res.json.connected, true);
  assert.equal(res.json.categoryTreeId, '0');
  assert.ok(!JSON.stringify(res.json).includes(FAKE_APP_ID));
});

test('endpoint /api/ebay/resolve-groups qua API: trả results + warnings, không lộ khóa/token', async () => {
  const store = new MemoryStore();
  const rt = makeRuntime(makeEbayFetch());
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/resolve-groups',
    body: { groups: [
      { groupKey: 'table-lamps', label: 'Table Lamps', sampleTitles: ['Soho Home Archie Table Lamp'] },
      { groupKey: 'nhom-la', label: 'Nhóm lạ Xyzzy', sampleTitles: ['Soho Home Xyzzy Thing'] },
    ] },
  }, { ebayRuntime: rt });
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'ebay-taxonomy');
  assert.equal(res.json.results.length, 2);
  assert.equal(res.json.results[0].categoryId, '177913');
  assert.equal(res.json.results[0].verifiedFromEbay, true);
  assert.equal(res.json.results[1].categoryId, null);
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes(FAKE_APP_ID) && !body.includes(FAKE_CERT_ID), 'resolve response không lộ khóa');
  assert.ok(!body.includes('mock-token-1'), 'resolve response không lộ token');
});

test('endpoint /api/ebay/resolve-groups khi chưa có khóa: lỗi rõ 400 ebay_not_configured, không crash', async () => {
  const store = new MemoryStore();
  const rt = new EbayTaxonomyRuntime({});
  rt.fetchFn = makeEbayFetch();
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ebay/resolve-groups',
    body: { groups: [{ groupKey: 'table-lamps', label: 'Table Lamps' }] },
  }, { ebayRuntime: rt });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'ebay_not_configured');
});

test('endpoint /api/ebay/category-suggestions: thiếu q -> 400; có q -> chỉ trả leaf', async () => {
  const store = new MemoryStore();
  const rt = makeRuntime(makeEbayFetch());
  const empty = await handleRequest(store, { method: 'GET', path: '/api/ebay/category-suggestions' }, { ebayRuntime: rt });
  assert.equal(empty.status, 400);
  const res = await handleRequest(store, { method: 'GET', path: '/api/ebay/category-suggestions?q=Table%20Lamps' }, { ebayRuntime: rt });
  assert.equal(res.status, 200);
  assert.equal(res.json.suggestions.length, 1);
  assert.equal(res.json.suggestions[0].id, '177913');
});

// ---- core.js: nhóm có mã Taxonomy -> file upload được -------------------------

test('nhóm có edits.ebayCategoryId: xuất file upload được ebay-<id>-<key>.csv, Category đúng mã, C: theo aspect names', () => {
  const lampVerified = lamp();
  lampVerified.edits = {
    ebayCategoryId: '177913',
    ebayCategoryName: 'Table Lamps',
    ebayCategoryPath: 'Home & Garden > Lamps > Table Lamps',
    ebayRequiredAspects: ['Type', 'Brand'],
    ebayRecommendedAspects: ['Bulb Type', 'Material'],
  };
  const products = [cushion(), lampVerified];
  const groups = groupProductsByTheme(products);
  const lampGroup = groups.find((g) => g.key === 'cat-177913');
  assert.ok(lampGroup, 'nhóm đèn phải tách theo mã eBay đã xác minh');
  assert.equal(lampGroup.resolvedCategory?.verifiedFromEbay, true);
  const { files, skipped } = buildGroupedEbayCsvs(products, template, config, groups);
  const lampFile = files.find((f) => f.groupKey === 'cat-177913');
  assert.ok(lampFile, 'nhóm đèn đã có mã phải có file upload được');
  assert.equal(lampFile.filename, 'ebay-177913-cat-177913.csv');
  assert.equal(lampFile.categoryId, '177913');
  assert.equal(lampFile.verifiedFromEbay, true);
  assert.deepEqual(lampFile.missingAspects, [], 'Type + Brand đều đã có giá trị nên không thiếu trường bắt buộc');
  const { headers, row } = firstDataRow(lampFile.csv);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '177913');
  // C:Type của đèn lấy từ dữ liệu sản phẩm ("Table Lamp"), KHÔNG phải Type
  // của gối (mapEbayType) và KHÔNG để trống.
  assert.equal(row[templateColumnIndex(headers, 'C:Type')], 'Table Lamp');
  // Aspect của đèn được thêm vào phần cột chung, không giữ cột riêng của gối.
  const bulbCol = templateColumnIndex(headers, 'C:Bulb Type');
  assert.ok(bulbCol >= 0, 'cột C:Bulb Type có trong schema đèn');
  assert.equal(templateColumnIndex(headers, 'C:Fill Material'), -1);
  assert.equal(row[bulbCol], 'LED');
  assert.equal(row[templateColumnIndex(headers, 'C:Material')], 'Brass');
  // Gối vẫn xuất file riêng, không trộn đèn vào.
  const cushionFile = files.find((f) => f.categoryId === '20563');
  assert.ok(cushionFile);
  assert.equal(cushionFile.productCount, 1);
  assert.equal(skipped.length, 0);
});

// ---- v8.2: file upload được có mã Taxonomy phải có khối Info ĐÚNG --------
// Lỗi còn sót sau v8.1: file đèn upload được (Category ghi mã 177913) vẫn
// xuất kèm các dòng Info của template gối 20563 ("For categoryId: 20563",
// "Back Cushion"...) — eBay File Exchange bỏ qua dòng Info khi import nên
// khả năng cao không ảnh hưởng upload, nhưng hiển thị sai và user báo lại.

test('file upload được của nhóm đèn đã tra mã: khối Info ghi đúng mã 177913, không còn 20563 hay aspect gối (v8.2)', () => {
  const lampVerified = lamp();
  lampVerified.edits = {
    ebayCategoryId: '177913',
    ebayCategoryName: 'Table Lamps',
    ebayCategoryPath: 'Home & Garden > Lamps > Table Lamps',
    ebayRequiredAspects: ['Type', 'Bulb Type'],
    ebayRecommendedAspects: ['Material'],
  };
  const { files } = buildGroupedEbayCsvs([cushion(), lampVerified], template, config);
  const lampFile = files.find((f) => f.groupKey === 'cat-177913');
  assert.ok(lampFile, 'nhóm đèn đã có mã phải có file upload được');
  assert.ok(lampFile.csv.includes('For categoryId: 177913'), 'khối Info ghi đúng mã đã tra');
  assert.ok(lampFile.csv.includes('The required aspects are Type; Bulb Type'), 'dòng required aspects lấy từ Taxonomy');
  assert.ok(!lampFile.csv.includes('20563'), 'file đèn không được chứa mã gối 20563 ở bất cứ đâu');
  assert.ok(!lampFile.csv.includes('Back Cushion'), 'file đèn không được chứa giá trị Type của gối');
  // Dòng dữ liệu vẫn ghi đúng mã.
  const { headers, row } = firstDataRow(lampFile.csv);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '177913');
  // File gối trong cùng lần xuất vẫn giữ infoRows 20563.
  const cushionFile = files.find((f) => f.categoryId === '20563');
  assert.ok(cushionFile.csv.includes('For categoryId:  20563'), 'file gối vẫn giữ dòng Info đúng của 20563');
});

test('file gối (không có resolvedCategory) vẫn giữ nguyên infoRows thật của template 20563 (v8.2)', () => {
  const { files } = buildGroupedEbayCsvs([cushion()], template, config);
  assert.equal(files.length, 1);
  assert.ok(files[0].csv.includes('For categoryId:  20563'));
  assert.ok(files[0].csv.includes('Back Cushion'), 'danh sách giá trị Type của gối vẫn còn trong Info');
});

test('resolvedCategory không có aspects: file ghi đúng mã + dòng ghi chú Taxonomy, không có 20563 (v8.2)', () => {
  const csvText = buildEbayTemplateCsv([lamp()], template, config, { resolvedCategory: { categoryId: '177913' } });
  assert.ok(csvText.includes('For categoryId: 177913'));
  assert.ok(csvText.includes('Aspects for this category were resolved via eBay Taxonomy'));
  assert.ok(!csvText.includes('20563'));
  assert.ok(!csvText.includes('Back Cushion'));
  const { headers, row } = firstDataRow(csvText);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '177913');
});

test('resolvedCategory có requiredAspects rỗng: ghi rõ "(not provided by Taxonomy response)", không có 20563 (v8.2)', () => {
  const csvText = buildEbayTemplateCsv([lamp()], template, config, { resolvedCategory: { categoryId: '177913', requiredAspects: [], recommendedAspects: [] } });
  assert.ok(csvText.includes('For categoryId: 177913'));
  assert.ok(csvText.includes('The required aspects are (not provided by Taxonomy response)'));
  assert.ok(!csvText.includes('20563'));
});

test('resolvedCategory có recommended values: thêm dòng "The recommended value(s) for aspect ..." theo định dạng template (v8.2)', () => {
  const csvText = buildEbayTemplateCsv([lamp()], template, config, {
    resolvedCategory: {
      categoryId: '177913',
      requiredAspects: ['Type'],
      recommendedAspects: [{ name: 'Bulb Type', values: ['LED', 'Incandescent'] }],
    },
  });
  assert.ok(csvText.includes('For categoryId: 177913'));
  assert.ok(csvText.includes('The required aspects are Type'));
  assert.ok(csvText.includes('The recommended value(s) for aspect Bulb Type: LED; Incandescent'));
  assert.ok(!csvText.includes('20563'));
});

test('nhóm có mã Taxonomy nhưng thiếu trường bắt buộc: trường đó để trống + liệt kê trong missingAspects, không bịa', () => {
  const lampNoType = makeProduct({ id: 'archie-table-lamp', title: 'Soho Home Archie Table Lamp', description: 'Table lamp.', specs: { Material: 'Brass' } });
  lampNoType.edits = {
    ebayCategoryId: '177913',
    ebayCategoryName: 'Table Lamps',
    ebayCategoryPath: 'Home & Garden > Lamps > Table Lamps',
    ebayRequiredAspects: ['Type', 'Brand'],
    ebayRecommendedAspects: ['Bulb Type', 'Material'],
  };
  const { files } = buildGroupedEbayCsvs([lampNoType], template, config);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].missingAspects, ['Type']);
  const { headers, row } = firstDataRow(files[0].csv);
  assert.equal(row[templateColumnIndex(headers, 'C:Type')], '', 'Type chưa có thì để trống, không bịa');
});

test('applyTaxonomyResolutions: ghi mã đã xác minh vào nhóm + edits sản phẩm, nhóm lạ giữ nguyên', () => {
  const products = [lamp(), mirror()];
  const groups = groupProductsByTheme(products);
  const applied = applyTaxonomyResolutions(products, groups, [
    { groupKey: 'lighting', categoryId: '177913', categoryName: 'Table Lamps', categoryPath: 'Home & Garden > Lamps > Table Lamps', requiredAspects: [{ name: 'Type' }, { name: 'Brand' }], recommendedAspects: [{ name: 'Bulb Type' }] },
  ]);
  assert.deepEqual(applied, { appliedGroups: 1, appliedProducts: 1 });
  const lampProduct = products.find((p) => p.title.includes('Table Lamp'));
  assert.equal(lampProduct.edits.ebayCategoryId, '177913');
  assert.equal(lampProduct.edits.ebayCategoryName, 'Table Lamps');
  // v9.4: aspect lưu dạng {name, values[]} để lúc xuất khớp được C:Type.
  assert.deepEqual(lampProduct.edits.ebayRequiredAspects, [{ name: 'Type', values: [] }, { name: 'Brand', values: [] }]);
  const mirrorProduct = products.find((p) => p.title.includes('Mirror'));
  assert.equal(mirrorProduct.edits?.ebayCategoryId, undefined, 'gương không tra mã thì không có mã');
  assert.equal(resolvedCategoryFromEdits(lampProduct.edits).verifiedFromEbay, true);
  assert.equal(resolvedCategoryFromEdits(mirrorProduct.edits), null);
});

test('groupProductsByAiAssignments: nhóm nào mọi sản phẩm đều có cùng mã Taxonomy thì gán mã cho nhóm', () => {
  const lampVerified = lamp();
  lampVerified.edits = { aiGroup: 'table-lamps', aiGroupLabel: 'Table Lamps', ebayCategoryId: '177913', ebayCategoryName: 'Table Lamps', ebayRequiredAspects: ['Type'] };
  const groups = groupProductsByAiAssignments([cushion(), lampVerified], [
    { productId: cushion().id, groupKey: 'cushions', groupLabel: 'Cushions' },
    { productId: lampVerified.id, groupKey: 'table-lamps', groupLabel: 'Table Lamps' },
  ]);
  const lampGroup = groups.find((g) => g.key === 'table-lamps');
  assert.equal(lampGroup.categoryId, '177913');
  assert.equal(lampGroup.resolvedCategory?.verifiedFromEbay, true);
});

// ---- An toàn: mã do AI đoán KHÔNG BAO GIỜ vào cột Category -------------------

test('mã do AI đoán (draftCategorySuggestion) không lọt vào cột Category: nhóm đó vẫn chỉ ra file nháp, Category trống', () => {
  const lampGuessed = lamp();
  lampGuessed.edits = { draftCategorySuggestion: { suggestedCategory: 'Table Lamps', categoryIdGuess: '177913', note: 'AI đoán, chưa xác minh' } };
  const products = [lampGuessed];
  const groups = groupProductsByTheme(products);
  assert.equal(groups[0].categoryId, null, 'AI đoán không tạo categoryId');
  assert.equal(groups[0].resolvedCategory, undefined);
  const { files } = buildGroupedEbayCsvs(products, template, config, groups);
  assert.equal(files.length, 0, 'nhóm chỉ có mã AI đoán thì không có file upload được');
  const { drafts } = buildDraftGroupedCsvs(products, template, { ...config, draftCategorySuggestions: [{ groupKey: groups[0].key, suggestedCategory: 'Table Lamps' }] }, groups);
  assert.equal(drafts.length, 1);
  const { headers, row } = firstDataRow(drafts[0].csv);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '', 'file nháp phải để trống Category');
  assert.ok(!drafts[0].csv.includes('177913'), 'file nháp không chứa mã AI đoán');
});

// ---- Không có khóa eBay -> fallback file nháp như v7 --------------------------

test('không có mã Taxonomy: buildGroupedEbayCsvs bỏ qua nhóm (skipped), buildDraftGroupedCsvs vẫn ra file nháp như v7', () => {
  const products = [cushion(), lamp(), mirror()];
  const groups = groupProductsByTheme(products);
  const { files, skipped } = buildGroupedEbayCsvs(products, template, config, groups);
  assert.equal(files.length, 1, 'chỉ gối có file upload được');
  assert.equal(files[0].categoryId, '20563');
  assert.equal(skipped.length, 2, 'đèn + gương bị bỏ qua, không xuất nhầm sang template gối');
  const { drafts } = buildDraftGroupedCsvs(products, template, config, groups);
  assert.equal(drafts.length, 2);
  for (const d of drafts) {
    const { headers, row } = firstDataRow(d.csv);
    assert.equal(row[templateColumnIndex(headers, 'Category')], '');
  }
});

test('autoSheetToCsv với taxonomyResolutions: nhóm đèn xuất file upload được, nhóm gương chưa tra mã vẫn ra file nháp', () => {
  const sheetCsv = [
    'TYPE,SOLD,ACCOUNT,FOLDER,NGÁCH BRAND,TITLE,DESCRIPTION,SIZE,EBAY,Site chính MIN - MAX 100$-1000$,Cứu đơn,COST,QTY,TOTAL COST,GIÁ BÁN,%ADS,ADS,PHÍ SÀN,LÃI/LỖ,PROFIT,RATE',
    'Table Lamp,,acc1,,Soho Home,Archie Table Lamp,"<p>Table lamp.</p>",,,"https://www.sohohome.com/us/products/archie-table-lamp",,300,,,"350",,,,,,',
    'Wall Mirror,,acc1,,Soho Home,Betty Wall Mirror,"<p>Wall mirror.</p>",,,"https://www.sohohome.com/us/products/betty-mirror",,200,,,"250",,,,,,',
  ].join('\n');
  const result = autoSheetToCsv(sheetCsv, [], template, {
    ...config,
    taxonomyResolutions: [
      { groupKey: 'lighting', categoryId: '177913', categoryName: 'Table Lamps', categoryPath: 'Home & Garden > Lamps > Table Lamps', requiredAspects: [{ name: 'Type' }], recommendedAspects: [] },
    ],
  });
  const lampFile = result.files.find((f) => f.groupKey === 'lighting');
  assert.ok(lampFile, 'nhóm đèn đã có mã xác minh thì xuất file upload được');
  assert.equal(lampFile.categoryId, '177913');
  const { headers, row } = firstDataRow(lampFile.csv);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '177913');
  assert.equal(result.stats.taxonomyResolvedGroups, 1);
  assert.equal(result.stats.taxonomyResolvedProducts, 1);
  const mirrorDraft = result.draftFiles.find((f) => f.groupKey === 'mirrors');
  assert.ok(mirrorDraft, 'nhóm gương chưa tra mã vẫn ra file nháp');
});

// ---- v9.4: C:Type của danh mục đã tra mã được tự điền theo danh sách giá trị Taxonomy ----
// Lỗi thật 16/11/2026 (user báo kèm ảnh Excel): 1 dòng đèn "Fleur Table Lamp, US", danh mục 19591 (Lighting Kits, đã tự áp mã OK),
// nhưng cột *C:Type BẮT BUỘC trống — vì mapEbayType chỉ khớp 22 giá trị của template gối 20563, còn đường xuất cho danh mục khác
// bỏ qua mapEbayType và điền Type qua aspectFromProduct, mà AI trích xuất + reader trang đều không sinh trường Type nên luôn trống.
// Giá trị Type của 19591 dưới đây là GIÁ TRỊ GIẢ LẬP hợp lý (Table Lamp, Floor Lamp, ...) — CHƯA xác nhận từ Taxonomy thật của
// eBay cho 19591; lúc chạy thật, danh sách này lấy từ getItemAspects (aspectValues) của đúng danh mục đó. Các test kiểm chứng
// LOGIC khớp (giữ values qua các tầng + khớp tiêu đề), không kiểm chứng giá trị thật của 19591.
const TYPE_VALUES_19591 = ['Table Lamp', 'Floor Lamp', 'Chandelier', 'Wall Light', 'Ceiling Light', 'Pendant Light'];
const fleurResolution = () => ({
  groupKey: 'lighting', categoryId: '19591', categoryName: 'Lighting Kits',
  categoryPath: 'Home & Garden > Lamps > Lighting Kits',
  requiredAspects: [{ name: 'Type', values: TYPE_VALUES_19591 }, { name: 'Brand', values: [] }],
  recommendedAspects: [],
});
const fleur = () => makeProduct({ id: 'fleur-table-lamp', title: 'Fleur Table Lamp, US', description: '', specs: { Material: 'Metal' } });

test('v9.4 hồi quy: đèn Fleur 19591 — C:Type tự điền "Table Lamp" theo danh sách giá trị Taxonomy', () => {
  const products = [fleur()];
  const groups = groupProductsByTheme(products);
  const applied = applyTaxonomyResolutions(products, groups, [fleurResolution()]);
  assert.deepEqual(applied, { appliedGroups: 1, appliedProducts: 1 });
  // Giá trị aspect được giữ nguyên qua applyTaxonomyResolutions (không chỉ tên).
  const fleurProduct = products[0];
  assert.deepEqual(fleurProduct.edits.ebayRequiredAspects, [
    { name: 'Type', values: TYPE_VALUES_19591 },
    { name: 'Brand', values: [] },
  ]);
  // resolvedCategoryFromEdits cũng giữ values khi đọc lại từ edits.
  const rc = resolvedCategoryFromEdits(fleurProduct.edits);
  assert.deepEqual(resolvedTypeValues(rc), TYPE_VALUES_19591);
  const lampGroup = groups.find((g) => g.key === 'lighting');
  assert.ok(lampGroup, 'đèn Fleur phải vào nhóm lighting');
  assert.equal(lampGroup.resolvedCategory?.verifiedFromEbay, true);
  const { files } = buildGroupedEbayCsvs(products, template, config, groups);
  const lampFile = files.find((f) => f.groupKey === 'lighting');
  assert.ok(lampFile, 'nhóm đèn 19591 phải có file upload được');
  assert.equal(lampFile.filename, 'ebay-19591-lighting.csv');
  assert.equal(lampFile.categoryId, '19591');
  const { headers, row } = firstDataRow(lampFile.csv);
  assert.equal(row[templateColumnIndex(headers, 'Category')], '19591');
  assert.equal(row[templateColumnIndex(headers, 'C:Type')], 'Table Lamp', 'C:Type khớp "Table Lamp" trong tiêu đề với danh sách giá trị 19591');
  assert.equal(row[templateColumnIndex(headers, 'C:Brand')], 'Soho Home');
  assert.equal(templateColumnIndex(headers, 'C:Material'), -1, 'fixture schema only contains Type and Brand');
  assert.equal(fleurProduct.specs.Material, 'Metal', 'source specs are still preserved for review');
  // Type đã khớp nên không còn báo thiếu, không còn warning C:Type.
  assert.ok(!lampFile.missingAspects.includes('Type'), 'Type đã điền thì không báo thiếu');
  assert.ok(!(lampFile.warnings ?? []).some((w) => /C:Type/.test(w)), 'Type khớp thì không báo vấn đề C:Type');
});

test('v9.4: tiêu đề không khớp giá trị Type nào → C:Type trống + warning, không bịa', () => {
  const product = makeProduct({ id: 'fleur-mystery', title: 'Soho Home Fleur, US', description: '', specs: { Material: 'Metal' } });
  const groups = [{
    key: 'lighting', label: 'Lighting', categoryId: '19591',
    resolvedCategory: {
      categoryId: '19591', categoryName: 'Lighting Kits',
      categoryPath: 'Home & Garden > Lamps > Lighting Kits',
      requiredAspects: [{ name: 'Type', values: TYPE_VALUES_19591 }, { name: 'Brand', values: [] }],
      recommendedAspects: [],
      verifiedFromEbay: true,
    },
    products: [product],
  }];
  const { files } = buildGroupedEbayCsvs([product], template, config, groups);
  assert.equal(files.length, 1);
  const { headers, row } = firstDataRow(files[0].csv);
  assert.equal(row[templateColumnIndex(headers, 'C:Type')], '', 'không khớp giá trị nào thì để trống, không bịa');
  assert.ok(files[0].missingAspects.includes('Type'), 'Type chưa khớp thì vẫn báo thiếu');
  assert.ok((files[0].warnings ?? []).some((w) => /C:Type chưa khớp được/.test(w)), 'phải có warning C:Type');
});

test('v9.4: edits.ebayType đã duyệt nhưng KHÔNG nằm trong danh sách cho phép → không điền; nằm trong danh sách → điền', () => {
  const resolved = {
    categoryId: '19591', categoryName: 'Lighting Kits',
    requiredAspects: [{ name: 'Type', values: TYPE_VALUES_19591 }, { name: 'Brand', values: [] }],
    recommendedAspects: [],
    verifiedFromEbay: true,
  };
  const notAllowed = makeProduct({ id: 'fleur-x', title: 'Soho Home Fleur, US', description: '', specs: {} });
  notAllowed.edits = { ...(notAllowed.edits ?? {}), ebayType: 'Bolster' };
  const csvNotAllowed = buildEbayTemplateCsv([notAllowed], template, config, { resolvedCategory: resolved });
  const firstNotAllowed = firstDataRow(csvNotAllowed);
  assert.equal(firstNotAllowed.row[templateColumnIndex(firstNotAllowed.headers, 'C:Type')], '', 'ebayType "Bolster" không nằm trong danh sách 19591 thì không được điền');

  const allowed = makeProduct({ id: 'fleur-y', title: 'Soho Home Fleur, US', description: '', specs: {} });
  allowed.edits = { ...(allowed.edits ?? {}), ebayType: 'Wall Light' };
  const csvAllowed = buildEbayTemplateCsv([allowed], template, config, { resolvedCategory: resolved });
  const firstAllowed = firstDataRow(csvAllowed);
  assert.equal(firstAllowed.row[templateColumnIndex(firstAllowed.headers, 'C:Type')], 'Wall Light', 'ebayType nằm trong danh sách thì được điền');

  // matchTypeValue: khớp giá trị dài nhất trong tiêu đề, ưu tiên ebayType đã duyệt.
  assert.equal(matchTypeValue({ title: 'Fleur Table Lamp, US', edits: {} }, TYPE_VALUES_19591), 'Table Lamp');
  assert.equal(matchTypeValue({ title: 'Fleur, US', edits: {} }, TYPE_VALUES_19591), '');
  assert.equal(mapResolvedCategoryType(notAllowed, {}, resolved), '');
  assert.equal(mapResolvedCategoryType(allowed, {}, resolved), 'Wall Light');
});

test('v9.4: danh mục đã tra mã nhưng Taxonomy không trả values cho Type (dữ liệu cũ dạng tên-only) → giữ hành vi cũ, lấy Type từ dữ liệu sản phẩm', () => {
  // Tương thích ngược: edits lưu từ các bản trước chỉ có tên aspect, không có values.
  const lampWithType = lamp();
  lampWithType.edits = {
    ebayCategoryId: '177913',
    ebayCategoryName: 'Table Lamps',
    ebayCategoryPath: 'Home & Garden > Lamps > Table Lamps',
    ebayRequiredAspects: ['Type', 'Brand'],
    ebayRecommendedAspects: ['Bulb Type', 'Material'],
  };
  const { files } = buildGroupedEbayCsvs([lampWithType], template, config);
  const lampFile = files.find((f) => f.groupKey === 'cat-177913');
  assert.ok(lampFile);
  const { headers, row } = firstDataRow(lampFile.csv);
  assert.equal(row[templateColumnIndex(headers, 'C:Type')], 'Table Lamp', 'không có danh sách values thì Type lấy từ specs như cũ, không trống oan');
  assert.ok(!lampFile.missingAspects.includes('Type'));
});
