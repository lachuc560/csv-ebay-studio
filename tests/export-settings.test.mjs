import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sellerExportConfig } from '../public/export-settings.js';
import Core from '../public/core.js';

const shared = {
  markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxCost: 0, roundTo99: false,
  listingCurrency: 'USD', exchangeRates: { GBP: 1.25 },
  ebayLocation: 'Shared Warehouse Never Export', ebayCountry: 'US', dispatchTimeMax: 9,
  shippingProfileName: 'Shared Shipping Never Export', returnProfileName: 'Shared Returns Never Export',
  paymentProfileName: 'Shared Payment Never Export', returnsAcceptedOption: 'ReturnsAccepted',
  returnsWithinOption: 'Days_60', refundOption: 'MoneyBack', shippingCostPaidByOption: 'Seller',
};

test('blank current seller does not inherit shop details stored in shared configuration', () => {
  const config = sellerExportConfig(shared);
  for (const field of ['ebayLocation', 'ebayCountry', 'dispatchTimeMax', 'shippingProfileName', 'returnProfileName',
    'paymentProfileName', 'returnsAcceptedOption', 'returnsWithinOption', 'refundOption', 'shippingCostPaidByOption']) {
    assert.equal(config[field], '', `${field} belongs to the current seller`);
  }
});

test('seller input is trimmed for one export while pricing, currency and exchange rates remain shared', () => {
  const sharedBefore = structuredClone(shared);
  const currentSeller = { ebayLocation: '  London  ', ebayCountry: ' gb ', dispatchTimeMax: 0,
    shippingProfileName: '  UK Shipping  ', returnProfileName: '  UK Returns  ', paymentProfileName: null,
    returnsAcceptedOption: ' ReturnsAccepted ', returnsWithinOption: ' Days_30 ',
    shippingCostPaidByOption: ' Buyer ', markupPct: 99, exchangeRates: { GBP: 99 } };
  const sellerBefore = structuredClone(currentSeller);
  const config = sellerExportConfig(shared, currentSeller);
  assert.equal(config.ebayLocation, 'London');
  assert.equal(config.ebayCountry, 'GB');
  assert.equal(config.dispatchTimeMax, '0');
  assert.equal(config.shippingProfileName, 'UK Shipping');
  assert.equal(config.returnProfileName, 'UK Returns');
  assert.equal(config.paymentProfileName, '');
  assert.equal(config.refundOption, '', 'an omitted return field does not fall back to another seller');
  assert.equal(config.returnsAcceptedOption, 'ReturnsAccepted');
  assert.equal(config.returnsWithinOption, 'Days_30');
  assert.equal(config.shippingCostPaidByOption, 'Buyer');
  for (const field of ['markupPct', 'ebayFeePct', 'shippingCost', 'taxCost', 'roundTo99', 'listingCurrency', 'exchangeRates']) {
    assert.deepEqual(config[field], shared[field], `${field} is not overridden by seller form fields`);
  }
  assert.notEqual(config, shared);
  assert.deepEqual(shared, sharedBefore);
  assert.deepEqual(currentSeller, sellerBefore);
});

test('successive CSV exports keep seller one policies out of seller two file and mark blanks for review', () => {
  const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
  const category = { categoryId: '20563', categoryName: 'Pillows', verifiedFromEbay: true,
    requiredAspects: [{ name: 'Brand', values: [] }], recommendedAspects: [] };
  const product = Core.normalizeRecord({ source_site: 'fixture.example', source_product_id: 'two-sellers',
    title: 'Fixture Pillow', brand: 'Fixture', description: 'A source product description.',
    images: ['https://fixture.example/pillow.jpg'], price: 10, currency: 'GBP',
    variants: [
      { sku: 'BLUE', price: 10, currency: 'GBP', in_stock: true, options: { Color: 'Blue' } },
      { sku: 'RED', price: 12, currency: 'GBP', in_stock: true, options: { Color: 'Red' } },
    ],
  }).product;
  const groups = [{ key: 'pillows', label: 'Pillows', products: [product], categoryId: category.categoryId, resolvedCategory: category }];
  const createFile = (seller) => {
    const { files, skipped } = Core.buildGroupedEbayCsvs([product], template, sellerExportConfig(shared, seller), groups);
    assert.deepEqual(skipped, []);
    assert.equal(files.length, 1);
    const rows = Core.parseCsvText(files[0].csv);
    const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell)));
    const data = rows.filter((row) => row[Core.templateColumnIndex(headers, 'Action')] === 'Add');
    const cell = (row, name) => row[Core.templateColumnIndex(headers, name)];
    assert.equal(data.length, 2);
    assert.doesNotMatch(headers[0], /Country=/i, 'seller country must not inherit the US template default');
    assert.deepEqual(data.map((row) => cell(row, 'StartPrice')), ['12.50', '15.00'], 'both exports retain shared FX/pricing');
    return { file: files[0], data, cell };
  };
  const first = createFile({ ebayLocation: ' London ', ebayCountry: 'gb', shippingProfileName: ' UK Shipping ', returnProfileName: ' UK Returns ' });
  assert.equal(first.file.needsReview, false);
  for (const row of first.data) {
    assert.equal(first.cell(row, 'Location'), 'London');
    assert.equal(first.cell(row, 'Country'), 'GB');
    assert.equal(first.cell(row, 'ShippingProfileName'), 'UK Shipping');
    assert.equal(first.cell(row, 'ReturnProfileName'), 'UK Returns');
  }
  const second = createFile({});
  assert.equal(second.file.needsReview, true);
  for (const row of second.data) {
    for (const field of ['Location', 'Country', 'DispatchTimeMax', 'ShippingProfileName', 'ReturnProfileName',
      'PaymentProfileName', 'ReturnsAcceptedOption', 'ReturnsWithinOption', 'RefundOption', 'ShippingCostPaidByOption']) {
      assert.equal(second.cell(row, field), '', `${field} is left for seller two to fill`);
    }
  }
  assert.doesNotMatch(second.file.csv, /UK Shipping|UK Returns|Shared .* Never Export|London/);
  for (const sku of ['BLUE', 'RED']) {
    assert.ok(second.file.validationIssues.some((issue) => issue.sku === sku && issue.field === 'Country'));
    assert.ok(second.file.validationIssues.some((issue) => issue.sku === sku && issue.field === 'ShippingProfileName'));
  }
});
