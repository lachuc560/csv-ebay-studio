// tests/cloudflare-images.test.mjs — Ảnh sản phẩm lên Cloudflare R2 (v9.1).
// KHÔNG gọi Cloudflare thật trong test — mock fetch (tải ảnh gốc + PUT
// S3 lên R2). Không có key thật trong file này — chỉ khóa R2 giả.
// Kiểm tra: mock R2 upload thành công -> product.images thành URL
// Cloudflare, originalImages giữ link gốc; R2 chưa cấu hình -> giữ link
// gốc + warning; 1 ảnh lỗi upload -> ảnh đó giữ link gốc, các ảnh khác
// vẫn lên Cloudflare; cùng URL gốc crawl lại lần 2 không gọi upload lần
// nữa (cache theo hash URL); PUT lên R2 ký SigV4 đúng (Authorization
// AWS4-HMAC-SHA256, x-amz-date, x-amz-content-sha256).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareImagesRuntime,
} from '../server/cloudflare-images.mjs';
import { MemoryStore, handleRequest, createApiKey } from '../server/api.mjs';

const R2_ENV = {
  CLOUDFLARE_R2_ACCOUNT_ID: 'test-acct-123',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'test-key-id',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'test-secret-key',
  CLOUDFLARE_R2_BUCKET: 'csv-images',
  CLOUDFLARE_R2_PUBLIC_URL: 'https://images.tencongty.com',
};
const IMG_A = 'https://assets.sohohome.com/a.jpg';
const IMG_B = 'https://assets.sohohome.com/b.png';

/** Mock fetch: GET ảnh gốc + PUT S3 lên R2. Ghi lại mọi lần gọi. */
function makeR2Fetch({ failUrls = [], putFail = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const method = String(init.method ?? 'GET').toUpperCase();
    if (method === 'PUT' && String(url).includes('r2.cloudflarestorage.com')) {
      if (putFail) return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    // GET ảnh gốc.
    if (failUrls.some((f) => String(url).includes(f))) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    const bytes = new TextEncoder().encode(`fake-image-bytes:${url}`);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          const n = String(name).toLowerCase();
          if (n === 'content-type') return 'image/jpeg';
          if (n === 'content-length') return String(bytes.length);
          return null;
        },
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => ({}),
    };
  };
  fn.calls = calls;
  fn.putCalls = () => calls.filter((c) => String(c.init?.method ?? 'GET').toUpperCase() === 'PUT');
  return fn;
}

/** AI runtime giả: chưa cấu hình key -> extract-page dùng luật, không gọi LLM. */
const ruleBasedAiRuntime = {
  getStatus: () => ({ configured: false, provider: 'rule-based', model: null, source: 'none' }),
  callLlmJson: async () => { throw new Error('no key'); },
};

test('v9.1 R2 (a): uploadImages thành công -> URL Cloudflare, PUT ký SigV4', async () => {
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  assert.equal(rt.isConfigured(), true);
  const { images, uploaded, warnings } = await rt.uploadImages([IMG_A, IMG_B]);
  assert.equal(uploaded, 2);
  assert.deepEqual(warnings, []);
  assert.ok(images[0].startsWith('https://images.tencongty.com/images/'), 'ảnh A thành link Cloudflare');
  assert.ok(images[0].endsWith('.jpg'), 'giữ đuôi .jpg của URL gốc');
  assert.ok(images[1].startsWith('https://images.tencongty.com/images/'), 'ảnh B thành link Cloudflare');
  assert.ok(images[1].endsWith('.png'), 'giữ đuôi .png của URL gốc');
  assert.notEqual(images[0], images[1], '2 URL gốc khác nhau -> 2 key khác nhau');
  // PUT lên đúng endpoint R2 + ký SigV4.
  const puts = fetchFn.putCalls();
  assert.equal(puts.length, 2);
  assert.ok(puts[0].url.startsWith('https://test-acct-123.r2.cloudflarestorage.com/csv-images/images/'), 'endpoint R2 đúng account + bucket');
  const auth = puts[0].init.headers.Authorization;
  assert.ok(auth.startsWith('AWS4-HMAC-SHA256 Credential=test-key-id/'), 'Authorization SigV4 với đúng Access Key ID');
  assert.match(puts[0].init.headers['x-amz-date'], /^\d{8}T\d{6}Z$/, 'có x-amz-date');
  assert.match(puts[0].init.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/, 'có x-amz-content-sha256 là hash body');
  // Key theo hash URL gốc: cùng URL -> cùng key.
  const key1 = await rt.imageKeyForUrl(IMG_A);
  const key2 = await rt.imageKeyForUrl(IMG_A);
  assert.equal(key1, key2);
});

test('R2 PUT signature matches a fixed SigV4 vector with sorted headers and an encoded object path', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T01:02:03.000Z') });
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  await rt.putObject('images/example image.png', new TextEncoder().encode('hello-r2'), 'image/png');
  const [{ url, init }] = fetchFn.putCalls();
  assert.equal(url, 'https://test-acct-123.r2.cloudflarestorage.com/csv-images/images/example%20image.png');
  assert.equal(init.headers['x-amz-date'], '20261119T010203Z');
  assert.equal(init.headers['x-amz-content-sha256'], '1fe42ffbee596f33cb1a2be061f32da1b403c04e4f02239a6f06c3db010412f0');
  // Golden signature independently calculated with node:crypto HMAC-SHA256,
  // using the canonical request rules documented by AWS. Do not derive the
  // expected value from production signing helpers: ordering bugs must fail.
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  assert.equal(init.headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=test-key-id/20261119/auto/s3/aws4_request, '
    + 'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, '
    + 'Signature=5b991fad6b768447aa3149af24a78ae2c67bb535480b11b7ea55736f1573a146');
});

test('v9.1 R2 (b): R2 chưa cấu hình -> giữ link gốc + warning rõ', async () => {
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime({}, fetchFn);
  assert.equal(rt.isConfigured(), false);
  assert.deepEqual(rt.getStatus(), { configured: false, bucket: null, publicUrl: null, source: 'none' });
  const { images, uploaded, warnings } = await rt.uploadImages([IMG_A, IMG_B]);
  assert.deepEqual(images, [IMG_A, IMG_B], 'giữ nguyên link ảnh gốc');
  assert.equal(uploaded, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Chưa cấu hình Cloudflare R2/);
  assert.equal(fetchFn.calls.length, 0, 'chưa cấu hình thì không gọi fetch nào');
});

test('v9.1 R2 (c): 1 ảnh lỗi upload -> ảnh đó giữ link gốc, ảnh khác vẫn lên', async () => {
  const fetchFn = makeR2Fetch({ failUrls: ['b.png'] });
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const { images, uploaded, warnings } = await rt.uploadImages([IMG_A, IMG_B]);
  assert.equal(uploaded, 1);
  assert.ok(images[0].startsWith('https://images.tencongty.com/images/'), 'ảnh A vẫn lên Cloudflare');
  assert.equal(images[1], IMG_B, 'ảnh B lỗi tải -> giữ link gốc');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /b\.png/);
  assert.equal(fetchFn.putCalls().length, 1, 'chỉ 1 lần PUT cho ảnh upload được');
});

test('v9.1 R2 (d): cùng URL gốc crawl lại lần 2 không gọi upload lần nữa', async () => {
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const first = await rt.uploadImages([IMG_A]);
  const second = await rt.uploadImages([IMG_A]);
  assert.deepEqual(second.images, first.images, 'lần 2 trả đúng URL Cloudflare đã cache');
  assert.equal(fetchFn.putCalls().length, 1, 'chỉ 1 lần PUT cho cùng URL gốc');
  assert.equal(second.uploaded, 0, 'lần 2 không tính là upload mới (lấy từ cache)');
});

test('v9.1 R2 (a2): extract-page xong -> product.images là link Cloudflare, originalImages giữ link gốc', async () => {
  const store = new MemoryStore();
  const imagesRuntime = new CloudflareImagesRuntime(R2_ENV, makeR2Fetch());
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/extract-page',
    body: {
      url: 'https://www.sohohome.com/us/products/daxton-square-cushion-olive/79996850',
      raw: {
        title: 'Soho Home Daxton Square Cushion Olive', price: 395, currency: 'USD',
        images: [IMG_A, IMG_B], description: 'Square cushion, olive.',
        variants: [{ options: { Color: 'Olive' }, price: 395, in_stock: true }],
      },
    },
  }, { aiRuntime: ruleBasedAiRuntime, imagesRuntime });
  assert.equal(status, 200);
  assert.equal(json.product.images.length, 2);
  assert.ok(json.product.images[0].startsWith('https://images.tencongty.com/images/'), 'PicURL sau này dùng link Cloudflare này');
  assert.ok(json.product.images[1].startsWith('https://images.tencongty.com/images/'));
  assert.deepEqual(json.product.originalImages, [IMG_A, IMG_B], 'link gốc giữ lại để đối chiếu');
  const reloaded = await store.getProduct(json.product.id);
  assert.deepEqual(reloaded.images, json.product.images, 'link Cloudflare đã lưu bền');
  assert.deepEqual(reloaded.originalImages, [IMG_A, IMG_B]);
});

test('v9.1 R2 (a3): ingest/records xong -> ảnh trong kho cũng là link Cloudflare', async () => {
  const store = new MemoryStore();
  const { key } = await createApiKey(store, 'test-crawl');
  const imagesRuntime = new CloudflareImagesRuntime(R2_ENV, makeR2Fetch());
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records',
    headers: { authorization: `Bearer ${key}` },
    body: {
      records: [{
        source_site: 'sohohome.com', source_product_id: 'daxton-square-cushion',
        title: 'Soho Home Daxton Square Cushion', price: 395, currency: 'USD',
        images: [IMG_A], variants: [{ options: { Color: 'Olive' }, price: 395, in_stock: true }],
      }],
    },
  }, { imagesRuntime });
  assert.equal(status, 200);
  assert.equal(json.imageWarnings, undefined, 'upload đủ thì không có warning ảnh');
  const products = await store.listProducts();
  assert.equal(products.length, 1);
  assert.ok(products[0].images[0].startsWith('https://images.tencongty.com/images/'));
  assert.deepEqual(products[0].originalImages, [IMG_A]);
});

test('v9.1 R2 (b2): ingest khi R2 chưa cấu hình -> giữ link gốc + imageWarnings', async () => {
  const store = new MemoryStore();
  const { key } = await createApiKey(store, 'test-crawl');
  const imagesRuntime = new CloudflareImagesRuntime({}, makeR2Fetch());
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records',
    headers: { authorization: `Bearer ${key}` },
    body: {
      records: [{
        source_site: 'sohohome.com', source_product_id: 'daxton-square-cushion',
        title: 'Soho Home Daxton Square Cushion', price: 395, currency: 'USD',
        images: [IMG_A], variants: [{ options: { Color: 'Olive' }, price: 395, in_stock: true }],
      }],
    },
  }, { imagesRuntime });
  assert.equal(status, 200);
  assert.equal(json.imageWarnings.length, 1);
  assert.match(json.imageWarnings[0], /Chưa cấu hình Cloudflare R2/);
  const products = await store.listProducts();
  assert.deepEqual(products[0].images, [IMG_A], 'giữ link ảnh gốc');
  assert.equal(products[0].originalImages, null);
});
