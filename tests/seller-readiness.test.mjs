import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Core from '../public/core.js';

const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
const category = { categoryId: '20563', categoryName: 'Pillows', verifiedFromEbay: true,
  requiredAspects: [{ name: 'Brand', values: [] }], recommendedAspects: [] };
const product = Core.normalizeRecord({ source_site: 'fixture.example', source_product_id: 'seller-readiness',
  title: 'Fixture Pillow', brand: 'Fixture', description: 'A source description.', price: 10, currency: 'USD',
  images: ['https://fixture.example/photo.jpg'], in_stock: true,
}).product;
const pricing = { markupPct: 0, ebayFeePct: 0, roundTo99: false };
const policies = { ...pricing, ebayLocation: 'Austin, TX', shippingProfileName: 'Fixture Shipping', returnProfileName: 'Fixture Returns' };
const check = (config = pricing, p = product, csv = null) => Core.validateEbayTemplateProducts([p], template, config, category, csv);

test('missing seller settings are review issues while a CSV remains downloadable', () => {
  const groups = [{ key: 'pillows', label: 'Pillows', products: [product], categoryId: category.categoryId, resolvedCategory: category }];
  const { files, skipped } = Core.buildGroupedEbayCsvs([product], template, pricing, groups);
  assert.equal(files.length, 1);
  assert.deepEqual(skipped, []);
  assert.match(files[0].csv, /Fixture Pillow/);
  assert.equal(files[0].needsReview, true);
  assert.deepEqual(files[0].validationIssues.filter((issue) => issue.code === 'missing_seller_setting').map((issue) => issue.field),
    ['Location', 'ShippingProfileName', 'DispatchTimeMax', 'ReturnsAcceptedOption']);
});

test('shipping and return policies replace handling and inline return terms; payment policy is optional', () => {
  const result = check(policies);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.validationIssues, []);
  assert.equal(product.edits?.shippingProfileName, undefined, 'validation does not save seller settings on the product');
});

test('accepted returns need period and return shipping payer without a return profile', () => {
  const config = { ...policies, returnProfileName: '', returnsAcceptedOption: 'ReturnsAccepted' };
  assert.deepEqual(check(config).validationIssues.map((issue) => issue.field), ['ReturnsWithinOption', 'ShippingCostPaidByOption']);
  assert.equal(check({ ...config, returnsWithinOption: 'Days_30', shippingCostPaidByOption: 'Buyer' }).needsReview, false);
  assert.equal(check({ ...config, returnsAcceptedOption: 'ReturnsNotAccepted' }).needsReview, false);
});

test('seller mistakes are reported without guessing or rewriting their return choices', () => {
  const config = { ...policies, shippingProfileName: '', dispatchTimeMax: '-1.5', returnProfileName: '',
    returnsAcceptedOption: 'ReturnsAccepted', returnsWithinOption: 'Days_30', shippingCostPaidByOption: 'Everyone' };
  const issues = check(config).validationIssues;
  assert.ok(issues.some((issue) => issue.field === 'DispatchTimeMax' && issue.code === 'invalid_seller_setting'));
  assert.ok(issues.some((issue) => issue.field === 'ShippingCostPaidByOption' && issue.code === 'invalid_seller_setting'));
  assert.equal(config.dispatchTimeMax, '-1.5');
  assert.equal(config.shippingCostPaidByOption, 'Everyone');
});

test('an explicit shipping service in the actual CSV can replace a shipping profile and same-day handling is valid', () => {
  const config = { ...policies, shippingProfileName: '', dispatchTimeMax: 0 };
  const rows = Core.parseCsvText(Core.buildEbayTemplateCsv([product], template, config));
  const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
  const data = rows.find((row) => row[0] === 'Add');
  data[headers.indexOf('ShippingService-1:Option')] = 'UPSGround';
  data[headers.indexOf('ShippingService-1:Cost')] = '0';
  const csv = rows.map((row) => row.map(Core.csvEscape).join(',')).join('\r\n');
  assert.equal(check(config, product, csv).needsReview, false);
});

test('every standalone SKU needs its own title, description and photos', () => {
  const p = { ...product, variants: [
    { sku: 'BLUE', price: 10, currency: 'USD', in_stock: true, options: { Color: 'Blue' } },
    { sku: 'RED', price: 10, currency: 'USD', in_stock: true, options: { Color: 'Red' } },
  ] };
  const rows = Core.parseCsvText(Core.buildEbayTemplateCsv([p], template, policies));
  const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
  const second = rows.filter((row) => row[0] === 'Add')[1];
  for (const field of ['Title', 'Description', 'PicURL']) second[Core.templateColumnIndex(headers, field)] = '';
  const csv = rows.map((row) => row.map(Core.csvEscape).join(',')).join('\r\n');
  const issues = check(policies, p, csv).validationIssues.filter((issue) => issue.code === 'missing_listing_field');
  assert.deepEqual(issues.map((issue) => [issue.sku, issue.field]), [['RED', 'Title'], ['RED', 'Description'], ['RED', 'PicURL']]);
});

test('an explicit Country column is validated from emitted cells without assuming a default country', () => {
  const csvWithCountry = (value) => {
    const rows = Core.parseCsvText(Core.buildEbayTemplateCsv([product], template, policies));
    const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
    headers.push('Country');
    const data = rows.find((row) => row[0] === 'Add');
    data[headers.length - 1] = value;
    return rows.map((row) => row.map(Core.csvEscape).join(',')).join('\r\n');
  };
  const blank = check({ ...policies, ebayCountry: 'US' }, product, csvWithCountry(''));
  assert.deepEqual(blank.validationIssues.map((issue) => [issue.field, issue.code]), [['Country', 'missing_seller_setting']],
    'a config value cannot mask a missing country in the file handed to the seller');
  for (const invalid of ['USA', '1V', 'United States']) {
    const issues = check(policies, product, csvWithCountry(invalid)).validationIssues;
    assert.deepEqual(issues.map((issue) => [issue.field, issue.code]), [['Country', 'invalid_seller_setting']]);
  }
  for (const valid of ['US', 'VN', 'gb']) assert.equal(check(policies, product, csvWithCountry(valid)).needsReview, false);
  assert.equal(check(policies).needsReview, false, 'legacy template without explicit Country keeps its header default');
});
