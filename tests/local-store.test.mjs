// tests/local-store.test.mjs — Lưu bền dữ liệu dev local (v6).
// V5 mất hết khi tắt Terminal: sản phẩm, config, khóa crawl đều ở RAM.
// LocalFileStore phải ghi file ngay khi đổi dữ liệu và tải lại đủ khi mở lại.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalFileStore, loadSnapshot, saveSnapshot, emptySnapshot } from '../scripts/local-store.mjs';

function tmpFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'csv-studio-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'local-data.json');
}

const sampleProduct = {
  id: 'soho_home_daxton-square-cushion',
  title: 'Daxton Square Cushion',
  source_site: 'soho_home',
  price: 280,
  variants: [{ options: { Size: '20 x 20 in' }, in_stock: true }],
  images: ['https://example.com/a.jpg'],
  version: 1,
};

test('chưa có file -> kho trống, không ném lỗi', (t) => {
  const store = new LocalFileStore(tmpFile(t));
  assert.equal(store.listProducts().length, 0);
  assert.equal(store.listKeys().length, 0);
  assert.equal(store.loadedAt, null);
});

test('putProduct/putMeta/khóa/lỗi crawl được ghi file ngay và tải lại đủ sau restart', (t) => {
  const file = tmpFile(t);
  const store = new LocalFileStore(file);
  store.putProduct(sampleProduct);
  store.putMeta('config', JSON.stringify({ markupPct: 0.35 }));
  store.createApiKeyRecord({ id: 'key_1', name: 'test', key_hash: 'abc123hash', created_at: '2026-11-13T00:00:00.000Z', last_used_at: null });
  store.pushCrawlError({ source_site: 'soho_home', message: 'timeout' });

  // File trên đĩa đã có ngay, chưa cần restart server.
  const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(onDisk.products.length, 1);
  assert.equal(onDisk.products[0].title, 'Daxton Square Cushion');
  assert.equal(onDisk.apiKeys.length, 1);
  assert.equal(onDisk.apiKeys[0].key_hash, 'abc123hash');
  assert.match(onDisk.meta.config, /markupPct/);

  // Mở lại (new store cùng file) như restart server: đủ dữ liệu.
  const reopened = new LocalFileStore(file);
  assert.equal(reopened.listProducts().length, 1);
  assert.equal(reopened.getProduct(sampleProduct.id).price, 280);
  assert.equal(reopened.getMeta('config'), JSON.stringify({ markupPct: 0.35 }));
  assert.equal(reopened.listKeys().length, 1);
  assert.equal(reopened.listKeys()[0].name, 'test');
  assert.equal(reopened.listCrawlErrors().length, 1);
  assert.equal(reopened.listCrawlErrors()[0].message, 'timeout');
  assert.ok(reopened.loadedAt, 'loadedAt ghi lại thời điểm file được lưu');
});

test('sửa sản phẩm đã lưu thì file trên đĩa đổi theo (không còn bản cũ)', (t) => {
  const file = tmpFile(t);
  const store = new LocalFileStore(file);
  store.putProduct(sampleProduct);
  store.putProduct({ ...sampleProduct, price: 300, version: 2 });
  const reopened = new LocalFileStore(file);
  assert.equal(reopened.listProducts().length, 1);
  assert.equal(reopened.getProduct(sampleProduct.id).price, 300);
});

test('clearData xoá cả file snapshot (mở lại vẫn trống)', (t) => {
  const file = tmpFile(t);
  const store = new LocalFileStore(file);
  store.putProduct(sampleProduct);
  store.clearData();
  const reopened = new LocalFileStore(file);
  assert.equal(reopened.listProducts().length, 0);
});

test('file hỏng: dời sang file .corrupt-* và bắt đầu kho trống, không mất file gốc', (t) => {
  const file = tmpFile(t);
  writeFileSync(file, '{ json hong', 'utf-8');
  const store = new LocalFileStore(file);
  assert.equal(store.listProducts().length, 0);
  assert.ok(store.loadedCorruptBackup, 'ghi lại đường dẫn file hỏng đã dời');
  const leftovers = readdirSync(path.dirname(file));
  assert.ok(leftovers.some((n) => n.startsWith('local-data.json.corrupt-')), `file hỏng được giữ lại, còn lại: ${leftovers.join(', ')}`);
});

test('loadSnapshot/saveSnapshot: snapshot rỗng hợp lệ, save rồi load lại khớp', (t) => {
  const file = tmpFile(t);
  const { snapshot } = loadSnapshot(file);
  assert.deepEqual(snapshot, emptySnapshot());
  const store = new LocalFileStore(file);
  store.putProduct(sampleProduct);
  const { snapshot: reloaded } = loadSnapshot(file);
  assert.equal(reloaded.products[0].id, sampleProduct.id);
  assert.equal(reloaded.version, 1);
  saveSnapshot(store, file);
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).products.length, 1);
});

test('debounceMs: gom nhiều thay đổi thành 1 lần ghi, flush() ghi ngay', async (t) => {
  const file = tmpFile(t);
  const store = new LocalFileStore(file, { debounceMs: 50 });
  let writes = 0;
  const origFlush = store.flush.bind(store);
  store.flush = () => { if (store.dirty) writes++; return origFlush(); };
  for (let i = 0; i < 100; i++) store.putProduct({ ...sampleProduct, id: `p${i}` });
  assert.equal(writes, 0, 'chưa ghi ngay trong chế độ debounce');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(writes, 1, '100 thay đổi chỉ ghi file 1 lần');
  assert.equal(new LocalFileStore(file).listProducts().length, 100);
  store.putMeta('config', '{"markupPct":0.5}');
  store.flush();
  assert.match(JSON.parse(readFileSync(file, 'utf-8')).meta.config, /0\.5/, 'flush() ghi nốt thay đổi cuối (dùng khi tắt server)');
});
