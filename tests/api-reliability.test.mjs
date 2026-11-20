import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, D1Store, VersionConflict, handleRequest, createApiKey, MAX_BODY_BYTES } from '../server/api.mjs';
import { AiRuntime } from '../server/ai-providers.mjs';

const record = {
  source_site: 'shop.example', source_product_id: 'lamp-1',
  source_url: 'https://shop.example/products/lamp-1', title: 'Desk Lamp', price: 30,
  images: ['https://shop.example/lamp.jpg'],
  variants: [{ sku: 'lamp-1', price: 30, currency: 'USD', in_stock: true }],
};
const noImages = { uploadImages: async (images) => ({ images, warnings: [] }) };
const noBrowse = { enrichProduct: async () => ({ matched: false }) };
const opts = { imagesRuntime: noImages, browseRuntime: noBrowse, aiRuntime: new AiRuntime() };
const request = (store, method, path, body, headers = {}, options = opts) => handleRequest(store, { method, path, body, headers }, options);

async function seed() {
  const store = new MemoryStore();
  const { key } = await createApiKey(store, 'test crawler');
  const headers = { authorization: `Bearer ${key}` };
  const result = await request(store, 'POST', '/api/ingest/records', { records: [record] }, headers);
  return { store, headers, id: result.json.products[0].id };
}

test('extension extract endpoint requires a valid crawl key and preserves the web response contract', async () => {
  const { store, headers } = await seed();
  const body = { url: record.source_url, sourceProductId: 'lamp-1', raw: record };
  const denied = await request(store, 'POST', '/api/ingest/extract-page', body);
  assert.equal(denied.status, 401);
  const accepted = await request(store, 'POST', '/api/ingest/extract-page', body, headers);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.product.source_product_id, 'lamp-1');
  assert.equal(accepted.json.product.variants[0].sku, 'lamp-1');
  assert.equal(accepted.json.provider, 'rule-based');
});

test('mixed ingest returns record errors alongside successful imports', async () => {
  const { store, headers } = await seed();
  const response = await request(store, 'POST', '/api/ingest/records', { records: [record, null] }, headers);
  assert.equal(response.status, 200);
  assert.equal(response.json.partial, true);
  assert.equal(response.json.products.length, 1);
  assert.equal(response.json.errors.length, 1);
  assert.equal(response.json.stats.errors, 1);
});

test('seller policies and explicit FX rates round trip; invalid pricing config is rejected atomically', async () => {
  const store = new MemoryStore();
  const config = { ebayLocation: 'Austin, TX', dispatchTimeMax: 0, shippingProfileName: 'Standard',
    returnProfileName: 'Returns', paymentProfileName: 'Payments', returnsAcceptedOption: 'ReturnsAccepted',
    listingCurrency: 'USD', exchangeRates: { GBP: 1.25 } };
  assert.equal((await request(store, 'PUT', '/api/config', config)).status, 200);
  const saved = (await request(store, 'GET', '/api/config')).json.config;
  for (const [key, value] of Object.entries(config)) assert.deepEqual(saved[key], value);
  for (const patch of [{ ebayFeePct: 1 }, { shippingCost: -2 }, { markupPct: null },
    { exchangeRates: { GBP: 0 } }, { dispatchTimeMax: -1 }, { roundTo99: 'maybe' },
    { markupPct: [] }, { dispatchTimeMax: [] }, { shippingCost: ' ' }]) {
    const bad = await request(store, 'PUT', '/api/config', { ebayLocation: 'Should not save', ...patch });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_config');
    assert.deepEqual((await request(store, 'GET', '/api/config')).json.config, saved);
  }
});

test('two sellers saving the same version: exactly one succeeds', async () => {
  const { store, id } = await seed();
  const responses = await Promise.all(['A', 'B'].map((title) => request(store, 'PUT', `/api/products/${id}`, { version: 1, edits: { title } })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(store.getProduct(id).version, 2);
});

test('image upload finishing after a seller edit keeps the edit', async () => {
  const { store, id, headers } = await seed();
  let finishUpload;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pendingUpload = new Promise((resolve) => { finishUpload = resolve; });
  const crawl = request(store, 'POST', '/api/ingest/records', { records: [record] }, headers, {
    ...opts, imagesRuntime: { uploadImages: async () => { markStarted(); return pendingUpload; } },
  });
  await started;
  const version = store.getProduct(id).version;
  const edit = await request(store, 'PUT', `/api/products/${id}`, { version, edits: { title: 'Seller approved title' } });
  assert.equal(edit.status, 200);
  finishUpload({ images: ['https://images.example/lamp.jpg'], warnings: [] });
  assert.equal((await crawl).status, 200);
  assert.equal(store.getProduct(id).edits.title, 'Seller approved title');
  assert.equal(store.getProduct(id).images[0], 'https://images.example/lamp.jpg');
  assert.equal(store.getProduct(id).version, version + 2);
});

test('ingest retries a stale version without dropping seller edits', async () => {
  const { store, id, headers } = await seed();
  const originalPut = store.putProduct.bind(store);
  let raced = false;
  store.putProduct = (product, expectedVersion) => {
    if (!raced && product.id === id && expectedVersion !== undefined) {
      raced = true;
      const latest = store.getProduct(id);
      originalPut({ ...latest, edits: { title: 'Concurrent edit' }, ebayItemId: 'seller-item-id', version: latest.version + 1 });
    }
    return originalPut(product, expectedVersion);
  };
  assert.equal((await request(store, 'POST', '/api/ingest/records', { records: [record] }, headers)).status, 200);
  assert.equal(store.getProduct(id).edits.title, 'Concurrent edit');
  assert.equal(store.getProduct(id).ebayItemId, 'seller-item-id');
  assert.equal(store.getProduct(id).version, 3);
});

test('D1 conditional updates reject a stale version and never fall back to an overwrite', async () => {
  const calls = [];
  const db = {
    exec: async () => {},
    prepare: (sql) => ({ bind: (...values) => ({ run: async () => { calls.push({ sql, values }); return { meta: { changes: 0 } }; } }) }),
  };
  const store = new D1Store({ DB: db });
  await assert.rejects(store.putProduct({ id: 'p1', version: 3 }, 2), VersionConflict);
  assert.match(calls[0].sql, /WHERE id = \?6 AND version = \?7/);
  assert.equal(calls[0].values[6], 2);
  await assert.rejects(store.putProduct({ id: 'p1', version: 1 }, 0), VersionConflict);
  assert.match(calls[1].sql, /ON CONFLICT\(id\) DO NOTHING/);
});

test('malformed edits and oversize AI requests fail before modifying data', async () => {
  const { store, id } = await seed();
  for (const body of [[], 'invalid', { edits: [] }, { edits: null }]) {
    assert.equal((await request(store, 'PUT', `/api/products/${id}`, body)).status, 400);
  }
  const response = await handleRequest(store, { method: 'POST', path: '/api/ai/extract-page', bodyText: 'x'.repeat(MAX_BODY_BYTES + 1) }, opts);
  assert.equal(response.status, 413);
  assert.equal(store.getProduct(id).version, 1);
});
