import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeRecord, parseImport, calcSellPrice, applyEdits, listingPriceForVariant,
  buildCsv, parseCsvText, parseEbayTemplate, buildEbayTemplateCsv,
  buildGroupedEbayCsvs, buildDraftGroupedCsvs,
} from '../public/core.js';

const template = parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
const config = { markupPct: 0, ebayFeePct: 0, roundTo99: false };
const record = (extra = {}) => ({
  source_site: 'sohohome.com', source_product_id: 'pillow-quality', title: 'Velvet Throw Pillow',
  price: 100, currency: 'USD', images: ['https://example.com/pillow.jpg'], ...extra,
});
const product = (extra = {}) => normalizeRecord(record(extra)).product;
const dataRows = (csv) => parseCsvText(csv).filter((row) => row[0] === 'Add');
const column = (name) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '') === name);

test('single variant keeps stock, SKU, UPC, price, image and currency without options', () => {
  const p = product({ variants: [{
    options: {}, price: 150, compare_at_price: 180, in_stock: false, stock_qty: 0,
    sku: 'SOURCE-150', upc: '012345678901', image: 'https://example.com/variant.jpg', currency: 'GBP',
  }] });
  assert.equal(p.variants.length, 1);
  assert.equal(p.variants[0].sku, 'SOURCE-150');
  assert.equal(p.variants[0].price, 150);
  assert.equal(p.variants[0].compare_at_price, 180);
  assert.equal(p.variants[0].stock_qty, 0);
  assert.equal(p.variants[0].image, 'https://example.com/variant.jpg');
  assert.equal(p.variants[0].currency, 'GBP');
  assert.equal(p.upc, '012345678901');
  assert.equal(p.in_stock_count, 0);
  assert.equal(dataRows(buildCsv([p], config)).length, 0);
  assert.equal(dataRows(buildEbayTemplateCsv([p], template, config)).length, 0);
});

test('all unavailable variants and sold-out product-level stock never become a new in-stock listing', () => {
  for (const p of [
    product({ variants: [{ options: { Color: 'Navy' }, price: 100, in_stock: false }] }),
    product({ variants: [{ options: { Color: 'Navy' }, price: 100, in_stock: true, stock_qty: 0 }] }),
    product({ in_stock: false }),
    product({ available: false }),
  ]) {
    assert.equal(p.in_stock_count, 0);
    assert.equal(dataRows(buildCsv([p], config)).length, 0);
    assert.equal(dataRows(buildEbayTemplateCsv([p], template, config)).length, 0);
  }
});

test('explicit unknown availability stays unknown and is excluded while a verified variant can export', () => {
  const p = product({ variants: [
    { options: { Color: 'Unknown' }, price: 110, in_stock: null },
    { options: { Color: 'Known' }, price: 130, in_stock: true },
  ] });
  assert.equal(p.variants[0].in_stock, null);
  assert.equal(p.in_stock_count, 1);
  const rows = dataRows(buildCsv([p], config));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][12], 'Known');
});

test('minimum product price considers available and quantity flags', () => {
  const p = product({ price: undefined, variants: [
    { options: { Color: 'Red' }, price: 100, available: false },
    { options: { Color: 'Blue' }, price: 110, stock_qty: 0 },
    { options: { Color: 'Green' }, price: 120, in_stock: true },
  ] });
  assert.equal(p.price, 120);
  assert.equal(p.in_stock_count, 1);
});

test('record option-name arrays do not become fake options on the default variant', () => {
  const p = product({ options: ['Size', 'Color'], variants: [] });
  assert.deepEqual(p.variants[0].options, {});
  assert.equal(dataRows(buildCsv([p], config))[0][13], '');
});

test('generic CSV emits each variant UPC rather than applying the first variant UPC to all', () => {
  const p = product({ variants: [
    { options: { Color: 'Red' }, price: 100, upc: '011111111111', sku: 'RED' },
    { options: { Color: 'Blue' }, price: 100, upc: '022222222222', sku: 'BLUE' },
  ] });
  const rows = dataRows(buildCsv([p], config));
  assert.deepEqual(rows.map((row) => row[9]), ['011111111111', '022222222222']);
  assert.deepEqual(rows.map((row) => row[1]), ['RED', 'BLUE']);
});

test('malformed array and currency fields reject only their own record in a mixed batch', () => {
  const input = [record(), record({ variants: {} }), record({ images: 'image.jpg' }),
    record({ variants: [null] }), record({ currency: 12 }), [],
    record({ source_product_id: 'second-good' })];
  const result = parseImport(input);
  assert.equal(result.products.length, 2);
  assert.equal(result.errors.length, 5);
  assert.equal(result.stats.total, 7);
});

test('source price ranges warn without discarding valid expensive products; non-finite prices fail', () => {
  const { product: expensive, errors } = normalizeRecord(record({ price: 12995 }));
  assert.deepEqual(errors, []);
  assert.equal(expensive.price, 12995);
  assert.ok(expensive.crawl_errors.some((message) => message.includes('outside reasonable range')));
  assert.equal(normalizeRecord(record({ price: Infinity })).product, null);
  assert.equal(normalizeRecord(record({ price: NaN })).product, null);
});

test('pricing accepts numeric config strings but rejects invalid fee, markup and shipping', () => {
  assert.equal(calcSellPrice(100, { ...config, shippingCost: '10', markupPct: '0.2' }), 132);
  for (const invalid of [{ ebayFeePct: 1 }, { ebayFeePct: Infinity }, { markupPct: -1 }, { shippingCost: -10 }, { taxPct: 'bad' }]) {
    assert.equal(calcSellPrice(100, { ...config, ...invalid }), null);
  }
});

test('per-product markup applies once in preview and both CSV exporters when variant price is missing', () => {
  const p = product();
  p.edits = { markupPct: 0.2 };
  p.variants[0].price = null;
  assert.equal(applyEdits(p, config).sell_price, 120);
  assert.equal(dataRows(buildCsv([p], config))[0][6], '120.00');
  assert.equal(dataRows(buildEbayTemplateCsv([p], template, config))[0][column('StartPrice')], '120.00');
});

test('foreign currency never silently exports as USD and does not show a guessed USD suggestion', () => {
  const p = product({ currency: 'GBP', price: 175 });
  assert.equal(applyEdits(p, config).sell_price, null);
  assert.throws(() => buildCsv([p], config), { code: 'currency_conversion_required', productId: p.id });
  assert.throws(() => buildEbayTemplateCsv([p], template, config), /GBP.*USD/);
  assert.equal(p.price, 175);
  assert.equal(p.currency, 'GBP');
});

test('explicit exchange rate converts source price before applying shipping in listing currency', () => {
  const p = product({ currency: 'GBP' });
  const rates = { ...config, exchangeRates: { GBP: 1.25 }, shippingCost: 10 };
  assert.equal(applyEdits(p, rates).sell_price, 135);
  assert.equal(dataRows(buildCsv([p], rates))[0][6], '135.00');
  assert.equal(dataRows(buildEbayTemplateCsv([p], template, rates))[0][column('StartPrice')], '135.00');
  assert.equal(p.price, 100);
  assert.equal(p.currency, 'GBP');
});

test('explicit listing price overrides foreign source currency, invalid edits never fall back silently', () => {
  const p = product({ currency: 'GBP' });
  p.edits.price = 80;
  assert.equal(dataRows(buildEbayTemplateCsv([p], template, config))[0][column('StartPrice')], '80.00');
  for (const invalid of [0, -1, Infinity, 'invalid', '']) {
    p.edits.price = invalid;
    assert.throws(() => buildCsv([p], config), { code: 'invalid_listing_price' });
  }
});

test('variant currency survives normalization and controls its own conversion', () => {
  const p = product({ variants: [{ options: { Color: 'Red' }, price: 100, currency: 'EUR' }] });
  assert.equal(p.variants[0].currency, 'EUR');
  assert.equal(listingPriceForVariant(p, p.variants[0], config), null);
  assert.throws(() => buildCsv([p], config), /EUR.*USD/);
  assert.equal(dataRows(buildCsv([p], { ...config, exchangeRates: { EUR: 1.1 } }))[0][6], '110.00');
});

test('CSV template currency cannot silently disagree with pricing configuration', () => {
  assert.throws(() => buildEbayTemplateCsv([product()], template, { ...config, listingCurrency: 'GBP' }), /Template dùng USD/);
  const gbpTemplate = { ...template, headers: template.headers.map((h) => h.replace('Currency=USD', 'Currency=GBP')) };
  const p = product({ currency: 'GBP' });
  assert.equal(dataRows(buildEbayTemplateCsv([p], gbpTemplate, { ...config, listingCurrency: 'GBP' }))[0][column('StartPrice')], '100.00');
});

test('group export keeps valid products and reports skipped price/stock failures by product ID', () => {
  const good = product({ source_product_id: 'good' });
  const missingRate = product({ source_product_id: 'foreign', currency: 'GBP' });
  const unavailable = product({ source_product_id: 'unavailable', in_stock: false });
  const all = [good, missingRate, unavailable];
  const { files, skipped } = buildGroupedEbayCsvs(all, template, config);
  assert.equal(files.length, 1);
  assert.equal(files[0].productCount, 1);
  assert.equal(dataRows(files[0].csv).length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].productCount, 2);
  assert.deepEqual(skipped[0].productIds, [missingRate.id, unavailable.id]);
  assert.deepEqual(skipped[0].issues.map((issue) => issue.code), ['currency_conversion_required', 'no_available_variants']);
  const group = [{ key: 'lighting', label: 'Lamps', products: all, categoryId: null }];
  const draft = buildDraftGroupedCsvs(all, template, config, group);
  assert.equal(draft.drafts.length, 1);
  assert.equal(draft.drafts[0].productCount, 1);
  assert.equal(draft.skipped[0].issues.length, 2);
});
