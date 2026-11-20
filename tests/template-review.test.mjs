import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Core from '../public/core.js';
import { extractPageRecord, ruleBasedExtractPage } from '../server/ai.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';
import { EbayTaxonomyError } from '../server/ebay-taxonomy.mjs';

const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
const config = { markupPct: 0, ebayFeePct: 0, roundTo99: false, ebayLocation: 'Austin, TX', shippingProfileName: 'Fixture shipping',
  dispatchTimeMax: 0, returnsAcceptedOption: 'ReturnsAccepted', returnsWithinOption: 'Days_30', shippingCostPaidByOption: 'Buyer' };
const category = { categoryId: '12345', categoryName: 'Fixture Lamps', verifiedFromEbay: true,
  requiredAspects: [{ name: 'Brand', values: [] }, { name: 'Voltage', values: ['120 V', '240 V'], aspectConstraint: { aspectMode: 'SELECTION_ONLY', aspectRequired: true } }],
  recommendedAspects: [] };
const product = (id, specs = {}) => Core.normalizeRecord({ source_site: 'shop.example', source_product_id: id,
  title: 'Test table lamp', price: 100, currency: 'USD', brand: 'Fixture', specs,
  description: 'A table lamp.', images: ['https://shop.example/lamp.jpg'], in_stock: true }).product;
const group = (products, resolved = category) => [{ key: 'fixture', label: 'Fixture', categoryId: resolved.categoryId, resolvedCategory: resolved, products }];

test('one complete product does not hide a missing required aspect in another product', () => {
  const products = [product('a', { Voltage: '120 V' }), product('b')];
  const { files } = Core.buildGroupedEbayCsvs(products, template, config, group(products));
  assert.equal(files[0].needsReview, true);
  assert.deepEqual(files[0].missingAspects, ['Voltage']);
  assert.deepEqual(files[0].validationIssues.filter((i) => i.field === 'C:Voltage').map((i) => i.productId), [products[1].id]);
});

test('required aspects are checked on every variant/SKU in the actual output', () => {
  const p = product('variants');
  p.variants = [{ sku: 'RED', price: 100, in_stock: true, options: { Color: 'Red' } }, { sku: 'UNKNOWN', price: 100, in_stock: true, options: {} }];
  const resolved = { ...category, requiredAspects: [{ name: 'Color', values: ['Red', 'Blue'], aspectConstraint: { aspectMode: 'SELECTION_ONLY' } }] };
  const review = Core.validateEbayTemplateProducts([p], template, config, resolved);
  assert.deepEqual(review.validationIssues.map((i) => [i.sku, i.field, i.code]), [['UNKNOWN', 'C:Color', 'missing_required_aspect']]);
});

test('selection-only values and dependent values are validated, free text is accepted', () => {
  const p = product('constraints', { Voltage: '999 V', Type: 'Custom desk lamp', Finish: 'Matte' });
  const resolved = { ...category, recommendedAspects: [
    { name: 'Type', values: ['Table Lamp'], aspectConstraint: { aspectMode: 'FREE_TEXT' } },
    { name: 'Finish', values: ['Matte'], aspectConstraint: { aspectMode: 'SELECTION_ONLY' }, aspectValues: [
      { localizedValue: 'Matte', valueConstraints: [{ applicableForLocalizedAspectName: 'Voltage', applicableForLocalizedAspectValues: ['120 V'] }] },
    ] },
  ] };
  const review = Core.validateEbayTemplateProducts([p], template, config, resolved);
  assert.ok(review.validationIssues.some((i) => i.field === 'C:Voltage' && i.code === 'invalid_aspect_value'));
  assert.ok(review.validationIssues.some((i) => i.field === 'C:Finish' && i.code === 'aspect_dependency'));
  assert.ok(!review.validationIssues.some((i) => i.field === 'C:Type'));
});

test('aspect constraints survive saved edits and same-category templates add new required columns', () => {
  const p = product('same', { Voltage: '120 V' });
  p.edits = { ebayCategoryId: template.categoryId, ebayRequiredAspects: category.requiredAspects };
  const resolved = Core.resolvedCategoryFromEdits(p.edits);
  assert.equal(resolved.requiredAspects[1].aspectConstraint.aspectMode, 'SELECTION_ONLY');
  const { files } = Core.buildGroupedEbayCsvs([p], template, config, group([p], resolved));
  assert.match(files[0].csv, /C:Voltage/);
  assert.deepEqual(files[0].missingAspects, []);
  assert.equal(files[0].needsReview, false);
});

test('unknown stock without a source variant remains unknown through AI extraction', () => {
  const raw = { source_site: 'shop.example', source_product_id: 'unknown', title: 'Lamp', price: 100, currency: 'USD', variants: [] };
  const record = extractPageRecord(raw, ruleBasedExtractPage(raw).extracted);
  const p = Core.normalizeRecord(record).product;
  assert.equal(p.variants[0].in_stock, null);
  assert.equal(Core.parseCsvText(Core.buildCsv([p], config)).filter((row) => row[0] === 'Add').length, 0);
});

test('a GBP variant without a price cannot borrow the USD product price, even with a GBP rate', () => {
  const raw = { source_site: 'shop.example', source_product_id: 'mixed', title: 'Lamp', price: 100, currency: 'USD',
    variants: [{ sku: 'GBP', currency: 'GBP', price: null, in_stock: true }] };
  for (const source of [raw, extractPageRecord(raw, ruleBasedExtractPage(raw).extracted)]) {
    const p = Core.normalizeRecord(source).product;
    assert.equal(p.variants[0].price, null);
    assert.equal(Core.listingPriceForVariant(p, p.variants[0], { ...config, exchangeRates: { GBP: 1.25 } }), null);
  }
});

test('direct Category ID route returns verified schema and actionable errors', async () => {
  const store = new MemoryStore();
  const good = await handleRequest(store, { method: 'GET', path: '/api/ebay/categories/12345' }, {
    ebayRuntime: { getCategoryDetails: async (id) => { assert.equal(id, '12345'); return category; } },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.json.category, category);
  const bad = await handleRequest(store, { method: 'GET', path: '/api/ebay/categories/abc' }, {
    ebayRuntime: { getCategoryDetails: async () => { throw new EbayTaxonomyError('invalid_category_id', 'Invalid category'); } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_category_id');
});

test('missing brand is not invented and a third variant option fills its own aspect', () => {
  const p = product('height');
  p.brand = null;
  p.variants[0].options = { Height: 'Tall' };
  const resolved = { ...category, requiredAspects: [{ name: 'Brand', values: ['Unbranded'] }, { name: 'Height', values: ['Tall', 'Regular'] }] };
  const review = Core.validateEbayTemplateProducts([p], template, config, resolved);
  assert.deepEqual(review.missingAspects, ['Brand']);
  assert.ok(!review.validationIssues.some((i) => i.field === 'C:Height'));
});
