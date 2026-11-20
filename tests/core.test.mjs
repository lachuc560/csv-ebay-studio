import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VARIANTS, SITE_RANGES, hashProductId, normalizeSite, normalizeRecord,
  parseImport, mergeProducts, applyEdits, calcSellPrice, truncateTitle,
  suggestCategory, validatePrice, variantRelationshipDetails, optionNamesFor,
  buildCsv, CSV_HEADERS, parseCsvText,
} from '../public/core.js';

const ogl = {
  source_site: 'OGL Move', source_product_id: 'abc123', source_url: 'https://oglmove.com/products/dress',
  title: 'Flowy Midi Dress', brand: 'OGL Move', price: 89, currency: 'USD',
  images: ['https://x/1.jpg', 'https://x/2.jpg'],
  variants: [
    { options: { Size: 'S', Color: 'Black', Height: 'Regular' }, price: 89, in_stock: true },
    { options: { Size: 'M', Color: 'Black', Height: 'Regular' }, price: 89, in_stock: true },
    { options: { Size: 'S', Color: 'Black', Height: 'Petite' }, price: 89, in_stock: false },
  ],
};

test('hashProductId is deterministic and keyed by site|id', () => {
  assert.equal(hashProductId('OGL Move', 'abc123'), hashProductId('ogl-move', 'abc123'));
  assert.notEqual(hashProductId('OGL Move', 'abc123'), hashProductId('Azazie', 'abc123'));
  assert.match(hashProductId('OGL Move', 'abc123'), /^p_[0-9a-f]{16}$/);
});

test('normalizeSite lowercases and hyphenates', () => {
  assert.equal(normalizeSite('Eileen Fisher'), 'eileen-fisher');
  assert.equal(normalizeSite('OGL Move'), 'ogl-move');
});

test('normalizeRecord keeps third option and flags in-stock count', () => {
  const { product, errors } = normalizeRecord(ogl);
  assert.deepEqual(errors, []);
  assert.equal(product.id, hashProductId('ogl-move', 'abc123'));
  assert.deepEqual(product.option_names, ['Size', 'Color', 'Height']);
  assert.equal(product.variant_count, 3);
  assert.equal(product.in_stock_count, 2);
  assert.equal(product.suggested_category, "Women's Dresses");
  assert.equal(product.price_estimated, false);
});

test('third option survives as extra_options / variant options, not dropped', () => {
  const { product } = normalizeRecord({
    ...ogl, variants: [{ size: 'S', color: 'Black', extra_options: { Height: 'Tall', 'Size-Bottom': 'Regular' }, price: 89, in_stock: true }],
  });
  assert.equal(product.variants[0].options.Height, 'Tall');
  assert.equal(product.variants[0].options['Size-Bottom'], 'Regular');
});

test('variantRelationshipDetails orders Size|Color|Height', () => {
  assert.equal(variantRelationshipDetails({ options: { Height: 'Regular', Color: 'Black', Size: 'S' } }), 'Size=S|Color=Black|Height=Regular');
});

test('optionNamesFor orders Size, Color, then extras alphabetically', () => {
  assert.deepEqual(optionNamesFor([{ options: { Height: 'Regular', Size: 'S' } }, { options: { Color: 'Black' } }]), ['Size', 'Color', 'Height']);
});

test('normalizeRecord rejects missing site/id/title', () => {
  assert.equal(normalizeRecord({ title: 'x' }).product, null);
  assert.equal(normalizeRecord({ source_site: 'azazie', source_product_id: '1' }).product, null);
  assert.ok(normalizeRecord({}).errors.length >= 2);
});

test('Amazon and Azazie are flagged price_estimated', () => {
  assert.equal(normalizeRecord({ ...ogl, source_site: 'Amazon', source_product_id: 'B01' }).product.price_estimated, true);
  assert.equal(normalizeRecord({ ...ogl, source_site: 'Azazie', source_product_id: 'A1' }).product.price_estimated, true);
  assert.equal(normalizeRecord({ ...ogl, source_site: 'Walmart', source_product_id: 'W1' }).product.price_estimated, false);
});

test('validatePrice warns outside SITE_RANGES but normalize still imports', () => {
  assert.ok(validatePrice('ogl-move', 5).length > 0);
  assert.deepEqual(validatePrice('ogl-move', 89), []);
  assert.ok(SITE_RANGES['eileen-fisher'][1] === 800);
});

test('parseImport merges duplicates in one batch and counts them', () => {
  const { products, stats } = parseImport([ogl, { ...ogl, price: 99 }]);
  assert.equal(products.length, 1);
  assert.equal(stats.mergedDuplicates, 1);
  assert.equal(products[0].price, 99);
  assert.equal(stats.total, 2);
});

test('parseImport collects errors without dropping good records', () => {
  const { products, errors, stats } = parseImport([ogl, { source_site: 'azazie' }, ogl]);
  assert.equal(products.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(stats.errors, 1);
});

test('mergeProducts: new source data wins, team edits and product_type preserved, version+1', () => {
  const { product: existing } = normalizeRecord(ogl);
  existing.edits = { title: 'Team Title', price: 120 };
  existing.product_type = 'dress';
  existing.category = 'Team Category';
  existing.version = 3;
  const { product: incoming } = normalizeRecord({ ...ogl, price: 95, title: 'New Source Title' });
  const merged = mergeProducts(existing, incoming);
  assert.equal(merged.price, 95);
  assert.equal(merged.title, 'New Source Title');
  assert.deepEqual(merged.edits, { title: 'Team Title', price: 120 });
  assert.equal(merged.product_type, 'dress');
  assert.equal(merged.category, 'Team Category');
  assert.equal(merged.version, 4);
});

test('applyEdits uses edited title/price, otherwise calcSellPrice', () => {
  const { product } = normalizeRecord(ogl);
  product.edits = { title: 'Edited' };
  const eff = applyEdits(product, { markupPct: 0.35, ebayFeePct: 0.13 });
  assert.equal(eff.title, 'Edited');
  assert.ok(eff.sell_price > 89);
  // (89)*(1.35)/(0.87)=138.10 -> floor + .99 = 138.99
  assert.equal(eff.sell_price, 138.99);
});

test('calcSellPrice rounds to .99 and returns null for bad price', () => {
  assert.equal(calcSellPrice(100, { markupPct: 0, ebayFeePct: 0, roundTo99: true }), 100.99);
  assert.equal(calcSellPrice(100, { markupPct: 0, ebayFeePct: 0, roundTo99: false }), 100);
  assert.equal(calcSellPrice(0), null);
  assert.equal(calcSellPrice('nope'), null);
});

test('truncateTitle caps at 80 chars', () => {
  assert.equal(truncateTitle('x'.repeat(100)).length, 80);
  assert.equal(truncateTitle('short'), 'short');
});

test('suggestCategory matches keywords, null otherwise', () => {
  assert.equal(suggestCategory('Summer Dress'), "Women's Dresses");
  assert.equal(suggestCategory('Yoga Leggings'), "Women's Activewear");
  assert.equal(suggestCategory('Mystery Gadget XYZ'), null);
});

test('buildCsv: single product, no Relationship when no options', () => {
  const { product } = normalizeRecord({ source_site: 'ebay', source_product_id: '1', title: 'Simple Mug', price: 15, images: ['https://x/1.jpg'] });
  const csv = buildCsv([product], { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], CSV_HEADERS.join(','));
  assert.equal(lines.length, 2);
  assert.ok(!lines[1].includes('Variation'));
});

test('buildCsv: each in-stock SKU is a complete independent listing and keeps the third option', () => {
  const { product } = normalizeRecord(ogl);
  const csv = buildCsv([product], { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  const [headers, ...rows] = parseCsvText(csv);
  const value = (row, name) => row[headers.indexOf(name)];
  // only 2 in-stock variants
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(value(row, 'Action'), 'Add');
    assert.equal(value(row, 'Title'), 'Flowy Midi Dress');
    assert.equal(value(row, 'PicURL'), 'https://x/1.jpg|https://x/2.jpg');
    assert.equal(value(row, 'Relationship'), '');
    assert.equal(value(row, 'Relationship details'), '');
    assert.equal(value(row, 'C:Color'), 'Black');
    assert.equal(value(row, 'C:Height'), 'Regular');
  }
  assert.equal(value(rows[0], 'C:Size'), 'S');
  assert.equal(value(rows[1], 'C:Size'), 'M');
  assert.ok(!csv.includes('Petite'), 'out-of-stock Petite variant must not be exported');
});

test('buildCsv caps at 250 variants', () => {
  const variants = Array.from({ length: 300 }, (_, i) => ({ options: { Size: `S${i}`, Color: 'Black' }, price: 50, in_stock: true }));
  const { product } = normalizeRecord({ source_site: 'azazie', source_product_id: 'big', title: 'Azazie Dress', price: 50, variants });
  assert.equal(product.truncated, true);
  const lines = buildCsv([product], { markupPct: 0, ebayFeePct: 0, roundTo99: false }).trim().split('\r\n');
  assert.equal(lines.length, 1 + MAX_VARIANTS);
});

test('buildCsv escapes commas and quotes in title', () => {
  const { product } = normalizeRecord({ source_site: 'ebay', source_product_id: '2', title: 'Dress, "Red" Special', price: 20 });
  const csv = buildCsv([product], { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  assert.ok(csv.includes('"Dress, ""Red"" Special"'));
});

test('buildCsv uses edited price when present', () => {
  const { product } = normalizeRecord(ogl);
  product.edits = { price: 199 };
  const csv = buildCsv([product], { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  assert.ok(csv.includes('199.00'));
});

test('extension v1.0.0 record: hostname source_site maps to slug, price from variants', () => {
  // Record thật như dist/content.js buildCsvRecord() gửi: source_site là hostname,
  // không có price cấp record, flags.price_estimated, crawl_truncated, description_text.
  const rec = {
    source_site: 'oglmove.com',
    source_url: 'https://oglmove.com/products/flowy-midi-dress',
    source_product_id: '123456789',
    crawled_at: '2026-11-13T00:00:00.000Z',
    brand: 'OGL Move',
    title: 'Flowy Midi Dress',
    breadcrumb: ['Women', 'Dresses'],
    department: 'Women',
    description_text: 'Soft dress',
    attributes: { material: '100% Rayon', fit: 'Regular', care: null, country_of_origin: null, dimensions: null },
    images: ['https://cdn.shopify.com/1.jpg'],
    options: ['Size', 'Color', 'Height'],
    variants: [
      { sku: 'SKU-1', size: 'S', color: 'Black', extra_options: { Height: 'Regular' }, price: 89, compare_at_price: 110, currency: 'USD', in_stock: true, stock_qty: null, upc: '123456789012', image: null },
      { sku: 'SKU-2', size: 'M', color: 'Black', extra_options: { Height: 'Regular' }, price: 95, compare_at_price: null, currency: 'USD', in_stock: true, stock_qty: null, upc: null, image: null },
    ],
    flags: { price_estimated: false },
    crawl_truncated: false,
  };
  const { product, errors } = normalizeRecord(rec);
  assert.deepEqual(errors, []);
  assert.equal(product.source_site, 'ogl-move');
  assert.equal(product.id, hashProductId('ogl-move', '123456789'));
  assert.equal(product.price, 89, 'product price = lowest in-stock variant price');
  assert.equal(product.currency, 'USD');
  assert.equal(product.upc, '123456789012');
  assert.equal(product.description, 'Soft dress');
  assert.equal(product.department, 'Women');
  assert.deepEqual(product.option_names, ['Size', 'Color', 'Height']);
  assert.equal(product.variants[0].options.Height, 'Regular');
  assert.equal(product.variants[0].compare_at_price, 110);
  assert.equal(product.price_estimated, false);
  assert.equal(product.truncated, false);
});

test('extension v1.0.0 record: Azazie generic fallback is single variant, price_estimated', () => {
  const { product } = normalizeRecord({
    source_site: 'azazie.com', source_product_id: 'az-1', title: 'Azazie Dress',
    images: ['https://x/1.jpg'], options: [], variants: [],
    flags: { price_estimated: true }, crawl_truncated: false,
  });
  // Không có variant nào trong record -> normalizeRecord không có giá -> vẫn import
  // với variant mặc định, price null; server phải chặn xuất khi price null (xem ingest test).
  assert.equal(product.source_site, 'azazie');
  assert.equal(product.price_estimated, true);
});

test('normalizeSite maps hostnames and keeps plain names', () => {
  assert.equal(normalizeSite('www.eileenfisher.com'), 'eileen-fisher');
  assert.equal(normalizeSite('amazon.com'), 'amazon');
  assert.equal(normalizeSite('Azazie'), 'azazie');
  assert.equal(normalizeSite('prana.com'), 'prana');
  assert.equal(normalizeSite('walmart.com'), 'walmart');
  assert.equal(normalizeSite('Eileen Fisher'), 'eileen-fisher');
});
