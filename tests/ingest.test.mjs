// tests/ingest.test.mjs — Test backend ingest + API (MemoryStore + handleRequest).
// Chạy: node --test tests/ingest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, handleRequest, createApiKey } from '../server/api.mjs';
import { chunkRecords, pushCrawl } from '../scripts/push-crawl.mjs';

// Record đúng shape extension v1.0.0 gửi (dist/content.js buildCsvRecord):
// source_site là hostname oglmove.com, không có price cấp record,
// variants dạng {sku, size, color, extra_options:{Height}, price, currency, in_stock}.
const oglRecord = {
  source_site: 'oglmove.com',
  source_url: 'https://oglmove.com/products/flowy-midi-dress',
  source_product_id: '123456789',
  crawled_at: '2026-11-13T00:00:00.000Z',
  brand: 'OGL Move',
  title: 'Flowy Midi Dress',
  breadcrumb: ['Women', 'Dresses'],
  department: 'Women',
  description_text: 'Soft dress',
  attributes: { material: '100% Rayon', fit: 'Regular', care: null, country_of_origin: null, dimensions: null },
  images: ['https://cdn.shopify.com/1.jpg', 'https://cdn.shopify.com/2.jpg'],
  options: ['Size', 'Color', 'Height'],
  variants: [
    { sku: 'SKU-1', size: 'S', color: 'Black', extra_options: { Height: 'Regular' }, price: 89, compare_at_price: 110, currency: 'USD', in_stock: true, stock_qty: null, upc: '123456789012', image: null },
    { sku: 'SKU-2', size: 'M', color: 'Black', extra_options: { Height: 'Regular' }, price: 95, compare_at_price: null, currency: 'USD', in_stock: true, stock_qty: null, upc: null, image: null },
  ],
  flags: { price_estimated: false },
  crawl_truncated: false,
};

async function setup() {
  const store = new MemoryStore();
  const { key } = await createApiKey(store, 'crawl');
  return { store, key };
}

const auth = (key) => ({ authorization: `Bearer ${key}` });

test('ping 401 khi không có khóa', async () => {
  const { store } = await setup();
  const res = await handleRequest(store, { method: 'GET', path: '/api/ingest/ping', headers: {} });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_api_key');
});

test('ping 200 với khóa đã tạo, trả tên khóa', async () => {
  const { store, key } = await setup();
  const res = await handleRequest(store, { method: 'GET', path: '/api/ingest/ping', headers: auth(key) });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.name, 'crawl');
});

test('ingest sai khóa → 401 invalid_api_key', async () => {
  const { store } = await setup();
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records',
    headers: auth('csvk_00000000000000000000000000000000'),
    body: { records: [oglRecord] },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_api_key');
});

test('ingest record đúng shape extension v1.0.0 → 200, summary đúng shape popup, products lưu được', async () => {
  const { store, key } = await setup();
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records',
    headers: auth(key),
    body: { records: [oglRecord] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.updated, false);
  assert.equal(res.json.products.length, 1);
  const p = res.json.products[0];
  assert.equal(p.title, 'Flowy Midi Dress');
  assert.equal(p.variants, 2);
  assert.equal(p.inStock, 2);
  assert.equal(p.images, 2);
  assert.equal(p.currency, 'USD');
  assert.equal(p.priceEstimated, false);
  assert.equal(p.price, 89);
  assert.match(p.id, /^p_[0-9a-f]{16}$/);

  const stored = await handleRequest(store, { method: 'GET', path: `/api/products/${p.id}`, headers: {} });
  assert.equal(stored.status, 200);
  assert.equal(stored.json.product.source_site, 'ogl-move');
  assert.equal(stored.json.product.version, 1);
  assert.equal(stored.json.product.variants[0].options.Height, 'Regular');
  assert.equal(stored.json.product.variants[1].options.Size, 'M');
});

test('ingest lại cùng sản phẩm → updated:true, version tăng, edits giữ nguyên', async () => {
  const { store, key } = await setup();
  const first = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: { records: [oglRecord] },
  });
  const id = first.json.products[0].id;

  // Team sửa title + product_type trước khi crawl lại.
  const edited = await handleRequest(store, {
    method: 'PUT', path: `/api/products/${id}`, headers: {},
    body: { edits: { title: 'Team Title' }, product_type: 'dress', version: 1 },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.product.version, 2);

  const second = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key),
    body: { records: [{ ...oglRecord, title: 'New Source Title' }] },
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.updated, true);
  const stored = await handleRequest(store, { method: 'GET', path: `/api/products/${id}`, headers: {} });
  assert.equal(stored.json.product.version, 3);
  assert.equal(stored.json.product.title, 'New Source Title');
  assert.deepEqual(stored.json.product.edits, { title: 'Team Title' });
  assert.equal(stored.json.product.product_type, 'dress');
});

test('ingest thiếu records → 400 records_required', async () => {
  const { store, key } = await setup();
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: {},
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'records_required');
});

test('ingest records không phải array → invalid_records; >200 → too_many_records', async () => {
  const { store, key } = await setup();
  const bad = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: { records: 'nope' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_records');

  const many = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key),
    body: { records: Array.from({ length: 201 }, () => oglRecord) },
  });
  assert.equal(many.status, 400);
  assert.equal(many.json.error, 'too_many_records');
});

test('PUT product sai version → 409 version_conflict', async () => {
  const { store, key } = await setup();
  const ingested = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: { records: [oglRecord] },
  });
  const id = ingested.json.products[0].id;
  const res = await handleRequest(store, {
    method: 'PUT', path: `/api/products/${id}`, headers: {},
    body: { edits: { title: 'X' }, version: 99 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'version_conflict');
  assert.equal(res.json.currentVersion, 1);
});

test('push-crawl chunkRecords không tách 1 sản phẩm và tôn trọng giới hạn 200', () => {
  // 250 record của cùng 1 sản phẩm + 250 record của 1 sản phẩm khác:
  // mỗi sản phẩm là 1 nhóm không tách được -> 2 chunk, mỗi chunk 250 record
  // (vượt maxRecords vì 1 sản phẩm đơn đã vượt — luật cho phép).
  const recs = [
    ...Array.from({ length: 250 }, () => ({ ...oglRecord })),
    ...Array.from({ length: 250 }, () => ({ ...oglRecord, source_product_id: 'other-1' })),
  ];
  const chunks = chunkRecords(recs, { maxBytes: 1_500_000, maxRecords: 200 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 250);
  assert.equal(chunks[1].length, 250);

  // Nhiều sản phẩm nhỏ: chunk không vượt 200 record.
  const small = Array.from({ length: 450 }, (_, i) => ({
    ...oglRecord, source_product_id: `p-${i}`, variants: [{ size: 'S', color: 'Black', price: 10, in_stock: true }],
  }));
  const chunks2 = chunkRecords(small, { maxBytes: 1_500_000, maxRecords: 200 });
  assert.equal(chunks2.length, 3);
  assert.ok(chunks2.every((c) => c.length <= 200));
  // Không sản phẩm nào bị tách: mỗi chunk chỉ chứa trọn vẹn các id.
  const seen = new Map();
  for (const c of chunks2) {
    for (const r of c) {
      assert.ok(!seen.has(r.source_product_id) || seen.get(r.source_product_id) === c, 'product split across chunks');
      seen.set(r.source_product_id, c);
    }
  }
});

test('pushCrawl POST từng chunk và gom kết quả (fetch giả lập)', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, updated: false,
        products: [{ id: 'p_x', title: 'T', variants: 1, inStock: 1, images: 0, currency: 'USD', priceEstimated: false, price: 10 }],
        stats: { total: 1, imported: 1, mergedDuplicates: 0, errors: 0 },
      }),
    };
  };
  const records = Array.from({ length: 3 }, (_, i) => ({ ...oglRecord, source_product_id: `p-${i}` }));
  const result = await pushCrawl({
    records, endpoint: 'http://localhost:8787/', apiKey: 'csvk_test',
    fetchFn, chunkOptions: { maxRecords: 2 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.chunks.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://localhost:8787/api/ingest/records');
  assert.equal(calls[0].body.records.length, 2);
  assert.equal(result.totalRecords, 3);
});

test('reset: có products → 409 has_real_data; không có → xoá hết', async () => {
  const { store, key } = await setup();
  const withData = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: { records: [oglRecord] },
  });
  assert.equal(withData.status, 200);
  const blocked = await handleRequest(store, { method: 'POST', path: '/api/reset', headers: {}, body: { confirm: true } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'has_real_data');

  const empty = new MemoryStore();
  const reset = await handleRequest(empty, { method: 'POST', path: '/api/reset', headers: {}, body: { confirm: true } });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
});

test('keys: tạo khóa chỉ hiện key một lần, list không lộ hash, xoá được', async () => {
  const store = new MemoryStore();
  const created = await handleRequest(store, { method: 'POST', path: '/api/keys', headers: {}, body: { name: 'crawl' } });
  assert.equal(created.status, 201);
  assert.match(created.json.key, /^csvk_[0-9a-f]{32}$/);

  const listed = await handleRequest(store, { method: 'GET', path: '/api/keys', headers: {} });
  assert.equal(listed.json.keys.length, 1);
  assert.equal(listed.json.keys[0].name, 'crawl');
  assert.equal(listed.json.keys[0].key, undefined);
  assert.equal(listed.json.keys[0].key_hash, undefined);

  const badName = await handleRequest(store, { method: 'POST', path: '/api/keys', headers: {}, body: { name: '  ' } });
  assert.equal(badName.status, 400);
  assert.equal(badName.json.error, 'name_required');

  const deleted = await handleRequest(store, { method: 'DELETE', path: `/api/keys/${created.json.id}`, headers: {} });
  assert.equal(deleted.status, 200);
  const missing = await handleRequest(store, { method: 'DELETE', path: `/api/keys/${created.json.id}`, headers: {} });
  assert.equal(missing.status, 404);
});

test('bootstrap trả products + config + crawlErrors + keys', async () => {
  const { store, key } = await setup();
  await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key),
    body: { records: [oglRecord, { source_site: 'azazie' }] },
  });
  const res = await handleRequest(store, { method: 'GET', path: '/api/bootstrap', headers: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.products.length, 1);
  assert.equal(res.json.config.markupPct, 0.35);
  assert.equal(res.json.keys.length, 1);
  assert.equal(res.json.crawlErrors.length, 1);
  assert.match(res.json.crawlErrors[0].message, /missing/);
});

test('route lạ → 404 not_found; ai/suggest theo luật không cần provider', async () => {
  const { store, key } = await setup();
  const unknown = await handleRequest(store, { method: 'GET', path: '/api/nope', headers: {} });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'not_found');

  const ingested = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: auth(key), body: { records: [oglRecord] },
  });
  const id = ingested.json.products[0].id;
  const ai = await handleRequest(store, { method: 'POST', path: '/api/ai/suggest', headers: {}, body: { productId: id } });
  assert.equal(ai.status, 200);
  assert.equal(ai.json.suggestion.title, 'Flowy Midi Dress');
  assert.equal(ai.json.suggestion.category, "Women's Dresses");
  assert.equal(ai.json.suggestion.specifics.Brand, 'OGL Move');
  assert.equal(ai.json.suggestion.specifics.Size, 'S, M');
  assert.equal(ai.json.suggestion.specifics.Color, 'Black');
  assert.deepEqual(ai.json.warnings, []);
});
