import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real browse predicates without a browser or server requests.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('// Browse data helpers:');
const end = source.indexOf('// Browse controls', start);
assert.ok(start >= 0 && end > start);
const helpers = vm.createContext({ URL, Intl });
vm.runInContext(source.slice(start, end), helpers);
const complete = {
  id: 'wall-light', title: 'Đèn tường Floria', brand: 'Soho Home', source_site: 'sohohome.com',
  price: 175, currency: 'GBP', description: 'A marble wall light.', images: ['https://example.com/image.jpg'],
  variants: [{ sku: 'LAMP-42', in_stock: true, price: 175, currency: 'GBP' }],
  edits: { ebayCategoryId: '116880', ebayCategoryName: 'Wall Fixtures', ebayRequiredAspects: [] },
};

test('browse search combines accent-insensitive words and SKU/category values without changing products', () => {
  const records = [complete, { ...complete, id: 'other', title: 'A pillow', variants: [{ sku: 'PILLOW-1', in_stock: true }], edits: {} }];
  const before = structuredClone(records);
  for (const query of ['den tuong', 'FLORIA lamp-42', '116880', 'wall fixtures']) {
    const result = helpers.filterBrowseProducts(records, query);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, complete.id);
  }
  assert.equal(helpers.filterBrowseProducts(records, 'absent').length, 0);
  assert.deepEqual(records, before);
});

test('stock filters and counts never label unknown, null or zero stock as confirmed available', () => {
  const stockRecords = [complete, ...[null, undefined, false].map((in_stock, index) => ({ ...complete, id: `stock-${index}`, variants: [{ in_stock }] })),
    { ...complete, id: 'zero', variants: [{ in_stock: true, stock_qty: 0 }] }];
  assert.equal(helpers.filterBrowseProducts(stockRecords, '', 'in_stock').length, 1);
  assert.equal(helpers.productStockSummary(stockRecords[1]).unknown, 1);
  assert.equal(helpers.productStockSummary(stockRecords[2]).unknown, 1);
  assert.equal(helpers.productStockSummary(stockRecords[3]).unknown, 0);
  assert.equal(helpers.productStockSummary(stockRecords[4]).available, 0);
});

test('review filter distinguishes saved category schema from an unchecked number and flags source gaps', () => {
  assert.equal(helpers.productReviewReasons(complete).length, 0);
  const missingSchema = { ...complete, edits: { ebayCategoryId: '116880' } };
  const missingImages = { ...complete, images: [] };
  const missingPrice = { ...complete, price: null };
  const warned = { ...complete, crawl_errors: ['Incomplete source'] };
  const records = [complete, missingSchema, missingImages, missingPrice, warned];
  assert.equal(helpers.filterBrowseProducts(records, '', 'needs_review').length, 4);
  assert.equal(helpers.productCategoryInfo(missingSchema).verified, false);
  assert.equal(helpers.productCategoryInfo(complete).verified, true);
});

test('source prices retain their currency and image previews reject non-web schemes', () => {
  assert.equal(helpers.sourceMoney(175, 'GBP'), '175,00 GBP');
  assert.equal(helpers.sourceMoney(null, 'USD'), '—');
  assert.equal(helpers.sourceMoney('bad', 'USD'), '—');
  assert.equal(helpers.safeProductImage('javascript:alert(1)'), '');
  assert.equal(helpers.safeProductImage('data:text/html,unsafe'), '');
  assert.equal(helpers.safeProductImage('https://example.com/photo.jpg'), 'https://example.com/photo.jpg');
});
