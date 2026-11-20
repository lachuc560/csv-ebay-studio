import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Core from '../public/core.js';

const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
const category = { categoryId: '116880', categoryName: 'Wall Fixtures', verifiedFromEbay: true,
  requiredAspects: [{ name: 'Brand', values: [] }], recommendedAspects: [] };
const strict = { markupPct: 0, ebayFeePct: 0, roundTo99: false };
const partial = { ...strict, allowIncompletePrice: true };
function product(id = 'foreign', overrides = {}) {
  return { id, title: 'Fixture wall light', brand: 'Fixture', description: 'A wall light.',
    price: 175, currency: 'GBP', images: ['https://fixture.example/light.jpg'], edits: {},
    variants: [{ sku: id, price: 175, currency: 'GBP', in_stock: true, options: {} }], ...overrides };
}
function group(products, config = partial) {
  return Core.buildGroupedEbayCsvs(products, template, config, [{ key: 'lights', label: 'Lights',
    categoryId: category.categoryId, resolvedCategory: category, products }]);
}
function cells(csv, field) {
  const rows = Core.parseCsvText(csv);
  const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
  return rows.filter((row) => row[Core.templateColumnIndex(headers, 'Action')] === 'Add')
    .map((row) => row[Core.templateColumnIndex(headers, field)]);
}

test('opt-in source export retains a foreign-currency product with an empty price and actionable review issue', () => {
  const p = product();
  const snapshot = structuredClone(p);
  const { files, skipped } = group([p]);
  assert.equal(files.length, 1);
  assert.deepEqual(skipped, []);
  assert.deepEqual(cells(files[0].csv, 'StartPrice'), ['']);
  assert.equal(files[0].needsReview, true);
  const issue = files[0].validationIssues.find((item) => item.code === 'currency_conversion_required');
  assert.equal(issue.field, 'StartPrice');
  assert.equal(issue.sku, 'foreign');
  assert.match(issue.message, /GBP.*USD/);
  assert.deepEqual(p, snapshot, 'export must not overwrite source data');
  assert.equal(Core.parseCsvText(Core.buildCsv([p], partial))[1][6], '', 'basic export also leaves price blank');
});

test('strict export remains strict unless incomplete price is explicitly enabled', () => {
  for (const allowIncompletePrice of [undefined, false, 'true']) {
    const config = { ...strict, allowIncompletePrice };
    assert.throws(() => Core.buildEbayTemplateCsv([product()], template, config), { code: 'currency_conversion_required' });
    const result = group([product()], config);
    assert.equal(result.files.length, 0);
    assert.equal(result.skipped[0].issues[0].code, 'currency_conversion_required');
  }
});

test('explicit listing price or exchange rate fills the price and removes the missing-price issue', () => {
  for (const [p, config, expected] of [
    [product('explicit', { edits: { price: 225 } }), partial, '225.00'],
    [product(), { ...partial, exchangeRates: { GBP: 1.2 } }, '210.00'],
  ]) {
    const file = group([p], config).files[0];
    assert.deepEqual(cells(file.csv, 'StartPrice'), [expected]);
    assert.equal(file.validationIssues.some((issue) => ['currency_conversion_required', 'invalid_listing_price'].includes(issue.code)), false);
  }
});

test('mixed SKU export retains valid prices and reports the exact SKU with a missing conversion', () => {
  const p = product('mixed', { variants: [
    { sku: 'USD-OK', price: 100, currency: 'USD', in_stock: true, options: {} },
    { sku: 'GBP-MISSING', price: 175, currency: 'GBP', in_stock: true, options: {} },
  ] });
  const file = group([p]).files[0];
  assert.deepEqual(cells(file.csv, 'StartPrice'), ['100.00', '']);
  assert.deepEqual(file.validationIssues.filter((issue) => issue.code === 'currency_conversion_required').map((issue) => issue.sku), ['GBP-MISSING']);
});

test('missing source prices and invalid seller prices export as blanks rather than zero or fallback guesses', () => {
  const samples = [
    product('missing', { price: null, currency: 'USD', variants: [{ sku: 'missing', price: null, currency: 'USD', in_stock: true }] }),
    ...[0, -1, Infinity, 'invalid', ''].map((price, index) => product(`invalid-${index}`, { edits: { price } })),
  ];
  const file = group(samples).files[0];
  assert.deepEqual(cells(file.csv, 'StartPrice'), samples.map(() => ''));
  assert.equal(file.validationIssues.filter((issue) => issue.code === 'invalid_listing_price').length, samples.length);
});

test('partial prices do not bypass unavailable inventory or a contradictory template currency', () => {
  const products = [product(), ...[false, null].map((in_stock, index) => product(`stock-${index}`, {
    variants: [{ sku: `stock-${index}`, price: 175, currency: 'GBP', in_stock }],
  }))];
  const result = group(products);
  assert.deepEqual(cells(result.files[0].csv, 'CustomLabel'), ['foreign']);
  assert.deepEqual(result.skipped[0].issues.map((issue) => issue.code), ['no_available_variants', 'no_available_variants']);
  assert.throws(() => Core.buildEbayTemplateCsv([product()], template, { ...partial, listingCurrency: 'GBP' }), /Template dùng USD/);
});
