import test from 'node:test';
import assert from 'node:assert/strict';

// Dev server từng sập khi Chrome/extension gửi req.url = '//':
// new URL('//', 'http://localhost') ném ERR_INVALID_URL ở dòng xử lý request.
// Test này kiểm tra server không sập và request sau đó vẫn chạy được.

test('parseRequestUrl: // và //api/... được chuẩn hoá, không ném lỗi', async () => {
  process.env.PORT = '0';
  const { parseRequestUrl } = await import('../scripts/dev-server.mjs');
  assert.equal(parseRequestUrl('//').pathname, '/');
  assert.equal(parseRequestUrl('//api/ingest/ping').pathname, '/api/ingest/ping');
  assert.equal(parseRequestUrl('/api/ingest/ping').pathname, '/api/ingest/ping');
  assert.equal(parseRequestUrl('').pathname, '/');
  assert.equal(parseRequestUrl(null).pathname, '/');
});

test('dev server sống sót sau GET // và vẫn phục vụ / và /api/ingest/ping', async () => {
  process.env.PORT = '0';
  const { default: server } = await import('../scripts/dev-server.mjs');
  const port = await new Promise((resolve) => {
    if (server.listening) resolve(server.address().port);
    else server.once('listening', () => resolve(server.address().port));
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(`${base}//`);
    assert.ok([200, 400, 404].includes(bad.status), `GET // trả ${bad.status}`);
    const badApi = await fetch(`${base}//api/ingest/ping`);
    assert.equal(badApi.status, 401, 'GET //api/ingest/ping vẫn vào đúng route và trả 401 khi không có khóa');
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Tool lấy dữ liệu/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
