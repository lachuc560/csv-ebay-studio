import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_RANGES, normalizeSite, normalizeRecord, validatePrice,
  parseCsvText, parseEbayTemplate, groupProductsByTheme, buildEbayTemplateCsv,
  mapEbayType, parseSohoDimensions, parseSohoWeight,
  parseBulkList, parseSheetCsv, sanitizeEbayDescription,
} from '../public/core.js';

// Template eBay thật: bản nhúng sẵn trong repo (public/templates/ebay-20563.csv,
// copy y hệt file user gửi ngày 13/11/2026) — test tự chạy được trong zip,
// không phụ thuộc file ngoài repo.
const TEMPLATE_PATH = new URL(
  '../public/templates/ebay-20563.csv',
  import.meta.url,
);
const templateText = readFileSync(TEMPLATE_PATH, 'utf-8');
const template = parseEbayTemplate(templateText);

// Record Soho Home thật, lấy từ trang thật đã fetch 13/11/2026
// (JSON-LD Product.offers: Cavern $1,470 non-member; Catherine Rug $2,450).
const cavern = {
  source_site: 'sohohome.com',
  source_url: 'https://www.sohohome.com/us/products/cavern-side-table',
  source_product_id: 'cavern-side-table',
  brand: 'Soho Home',
  title: 'Cavern Side Table',
  description_text: 'A square top crafted from a mix of travertine and marble.',
  images: [
    'https://assets.sohohome.com/images/original/296830-79940020-listingjpg.jpg',
    'https://assets.sohohome.com/images/original/296828-79940020-detail1jpg.jpg',
  ],
  breadcrumb: ['Furniture', 'Side Tables'],
  attributes: { material: 'Ash Wood, MDF, cement board, Grey Pesco Marble' },
  specs: {
    Dimensions: 'H45 x W50 x D50cm / H18 x W20 x D20"',
    Material: 'Ash Wood, MDF, cement board, Grey Pesco Marble, Jade Shell Marble, Travertine and Michelangelo Marble',
    Weight: '15kg / 33.1lbs',
    'Care instructions': 'Wipe with a damp cloth.',
  },
  variants: [{ options: {}, price: 1470, compare_at_price: 2095, in_stock: true }],
};

const catherineRug = {
  source_site: 'sohohome.com',
  source_url: 'https://www.sohohome.com/us/products/catherine-rug-navy-round',
  source_product_id: 'catherine-rug-navy-round',
  brand: 'Soho Home',
  title: 'Catherine Rug Navy, Round, 200 x 200cm',
  description_text: 'Hand-knotted in India by skilled artisans.',
  images: ['https://assets.sohohome.com/images/original/342214-72746086-listingjpg.jpg'],
  breadcrumb: ['Furniture', 'Rugs'],
  attributes: { material: '100% Wool' },
  specs: { Composition: 'Pile: 100% Wool Base: 100% Cotton Overall: 54% Wool, 46% Cotton', Dimensions: 'H200 x W200 x D3cm' },
  variants: [{ options: { Size: '200 x 200cm' }, price: 2450, in_stock: true }],
};

const throwPillow = {
  source_site: 'sohohome.com',
  source_url: 'https://www.sohohome.com/us/products/velvet-throw-pillow',
  source_product_id: 'velvet-throw-pillow',
  brand: 'Soho Home',
  title: 'Soho Home Velvet Throw Pillow',
  description_text: '<div>Soft velvet cushion</div><script>alert(1)</script><a href="https://example.com">shop</a>',
  images: ['https://assets.sohohome.com/images/pillow1.jpg', 'https://assets.sohohome.com/images/pillow2.jpg'],
  breadcrumb: ['Furniture', 'Cushions'],
  attributes: { material: '100% Cotton' },
  specs: { Dimensions: 'H45 x W45 x D15cm / H18 x W18 x D6"' },
  variants: [
    { options: { Size: '18 x 18 in', Color: 'Navy' }, price: 150, in_stock: true },
    { options: { Size: '18 x 18 in', Color: 'Emerald' }, price: 150, in_stock: true },
  ],
};

test('parseEbayTemplate: template 20563 thật — 98 cột, categoryId, required aspects', () => {
  assert.equal(template.headers.length, 98);
  assert.equal(template.headers[0], '*Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)');
  assert.equal(template.categoryId, '20563');
  assert.deepEqual(template.requiredAspects, ['Type', 'Brand']);
  assert.ok(template.recommendedValues.Type.includes('Throw Pillow'));
  assert.ok(template.recommendedValues.Type.includes('Cushion'));
  // Danh sách Brand tràn nhiều dòng Info — phải cộng dồn được.
  assert.ok(template.recommendedValues.Brand.includes('Unbranded'));
  assert.ok(template.recommendedValues.Brand.length > 100);
  assert.equal(template.versionRow[0], 'Info');
  // Dòng 0 version + dòng 1 header + 39 dòng sau header (3 trống + 36 Info).
  assert.equal(template.infoRows.length, 39);
});

test('Soho Home: normalizeSite + SITE_RANGES, giá thật không bị chặn', () => {
  assert.equal(normalizeSite('sohohome.com'), 'soho-home');
  assert.equal(normalizeSite('www.sohohome.com'), 'soho-home');
  assert.deepEqual(SITE_RANGES['soho-home'], [100, 5000]);
  assert.deepEqual(validatePrice('soho-home', 1470), []);
  assert.deepEqual(validatePrice('soho-home', 2450), []);
  const { product, errors } = normalizeRecord(cavern);
  assert.deepEqual(errors, []);
  assert.equal(product.source_site, 'soho-home');
  assert.equal(product.price, 1470, 'giá JSON-LD = giá non-member, không phải Member $1,176');
  assert.equal(product.variants[0].compare_at_price, 2095, 'Regular Price $2,095 là compare-at');
  assert.equal(product.brand, 'Soho Home');
  assert.equal(product.images.length, 2);
  assert.equal(product.suggested_category, 'Tables');
});

test('Soho Home: size thảm lấy từ tiêu đề, không gộp size trang khác thành biến thể', () => {
  // parseSohoSizeFromTitle đã xoá khỏi core.js từ v9.2 (không còn chỗ nào
  // gọi); size thảm vẫn kiểm qua normalizeRecord bên dưới.
  const { product } = normalizeRecord(catherineRug);
  assert.equal(product.price, 2450);
  assert.equal(product.variants[0].options.Size, '200 x 200cm');
  assert.equal(product.variants.length, 1, '170x240cm là trang riêng, không phải biến thể trang này');
});

test('parseSohoDimensions / parseSohoWeight: cm + inch, kg/lbs', () => {
  assert.deepEqual(parseSohoDimensions('H45 x W50 x D50cm / H18 x W20 x D20"'), {
    dimensions: 'H45 x W50 x D50cm / H18 x W20 x D20"',
    itemHeight: '18 in',
    itemWidth: '20 in',
    itemLength: '20 in',
  });
  const cmOnly = parseSohoDimensions('H200 x W200 x D3cm');
  assert.equal(cmOnly.itemHeight, '78.7 in');
  assert.equal(parseSohoWeight('15kg / 33.1lbs'), '33.1 lb');
  assert.equal(parseSohoWeight('6.7kg / 14.8lbs'), '14.8 lb');
  assert.equal(parseSohoWeight('14.8 lb'), '14.8 lb');
  assert.equal(parseSohoWeight(''), null);
});

test('groupProductsByTheme: gối vs thảm vs đèn tách file riêng', () => {
  const lamp = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'lamp-1', title: 'Soho Home Brass Table Lamp',
    price: 350, variants: [{ options: {}, price: 350, in_stock: true }],
  }).product;
  const products = [
    normalizeRecord(throwPillow).product,
    normalizeRecord(catherineRug).product,
    lamp,
    normalizeRecord(cavern).product,
  ];
  const groups = groupProductsByTheme(products);
  assert.deepEqual(groups.map((g) => g.key), ['cushions', 'rugs', 'lighting', 'tables']);
  assert.equal(groups[0].categoryId, '20563');
  assert.equal(groups[0].products.length, 1);
  assert.equal(groups[1].products[0].title, 'Catherine Rug Navy, Round, 200 x 200cm');
});

test('groupProductsByTheme: theme team ghi và categoryId đã chốt được ưu tiên', () => {
  const themed = normalizeRecord({
    ...cavern, source_product_id: 'cavern-2', theme: 'Bàn ghế phòng khách',
  }).product;
  assert.equal(groupProductsByTheme([themed])[0].label, 'Bàn ghế phòng khách');
  const byCat = normalizeRecord({
    ...cavern, source_product_id: 'cavern-3', category_id: '20563',
  }).product;
  const g = groupProductsByTheme([byCat]);
  assert.equal(g[0].key, 'cat-20563');
  assert.equal(g[0].categoryId, '20563');
  const other = normalizeRecord({
    source_site: 'ebay', source_product_id: 'x1', title: 'Mystery Gadget XYZ', price: 20,
  }).product;
  assert.equal(groupProductsByTheme([other])[0].key, 'other');
});

test('mapEbayType: khớp giá trị gợi ý dài nhất, không khớp thì để trống', () => {
  const pillow = normalizeRecord(throwPillow).product;
  assert.equal(mapEbayType(pillow, template), 'Throw Pillow');
  assert.equal(mapEbayType(normalizeRecord(cavern).product, template), '');
  const lumbar = normalizeRecord({ ...throwPillow, source_product_id: 'lumbar-1', title: 'Soho Home Lumbar Pillow' }).product;
  assert.equal(mapEbayType(lumbar, template), 'Lumbar Pillow');
});

test('buildEbayTemplateCsv: header khớp 100% template, Type/Brand đúng cột, Title ≤80', () => {
  const pillow = normalizeRecord(throwPillow).product;
  const csv = buildEbayTemplateCsv([pillow], template, { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  const rows = parseCsvText(csv);
  assert.deepEqual(rows[1], template.headers, 'dòng header phải y hệt template');
  assert.deepEqual(rows[0], template.versionRow, 'dòng Info Version giữ nguyên');
  assert.equal(rows.length, 2 + template.infoRows.length + 2, '2 biến thể còn hàng = 2 dòng sản phẩm');
  const col = (name) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '') === name);
  const r1 = rows[2 + template.infoRows.length];
  assert.equal(r1[col('Action')], 'Add');
  assert.equal(r1[col('Category')], '20563');
  assert.equal(r1[col('C:Type')], 'Throw Pillow');
  assert.equal(r1[col('C:Brand')], 'Soho Home');
  assert.equal(r1[col('C:Color')], 'Navy');
  assert.equal(r1[col('C:Size')], '18 x 18 in');
  assert.equal(r1[col('C:Material')], '100% Cotton');
  assert.equal(r1[col('ConditionID')], '1000');
  assert.equal(r1[col('Format')], 'FixedPrice');
  assert.equal(r1[col('Duration')], 'GTC');
  assert.equal(r1[col('StartPrice')], '150.00');
  assert.equal(r1[col('Quantity')], '1');
  assert.equal(r1[col('PicURL')], 'https://assets.sohohome.com/images/pillow1.jpg|https://assets.sohohome.com/images/pillow2.jpg');
  assert.equal(r1[col('Relationship')], '');
  assert.equal(r1[col('RelationshipDetails')], '');
  assert.ok(r1[col('Title')].length <= 80);
  assert.ok(!r1[col('Description')].includes('<script'), 'mô tả phải lọc script');
  assert.ok(!r1[col('Description')].includes('example.com'), 'mô tả phải lọc link ngoài');
  assert.ok(r1[col('Description')].includes('Soft velvet cushion'));
  // SKU thứ hai là một listing riêng, cần đủ nội dung như SKU đầu.
  const r2 = rows[2 + template.infoRows.length + 1];
  assert.equal(r2[col('Action')], 'Add');
  assert.equal(r2[col('Title')], r1[col('Title')]);
  assert.equal(r2[col('PicURL')], r1[col('PicURL')]);
  assert.equal(r2[col('Description')], r1[col('Description')]);
  assert.equal(r2[col('Relationship')], '');
  assert.equal(r2[col('RelationshipDetails')], '');
  assert.equal(r2[col('C:Color')], 'Emerald');
});

test('independent SKU listings retain source options and select the matching mirrored image', () => {
  const p = normalizeRecord({ ...throwPillow, variants: [
    { sku: 'NAVY', options: { Size: '18 x 18 in', Color: 'Navy', Height: 'Regular' }, price: 150, in_stock: true, image: 'https://source.example/navy.jpg' },
    { sku: 'GREEN', options: { Size: '18 x 18 in', Color: 'Emerald', Height: 'Tall' }, price: 160, in_stock: true, image: 'https://source.example/green.jpg' },
  ] }).product;
  p.originalImages = ['https://source.example/navy.jpg', 'https://source.example/green.jpg'];
  p.images = ['https://images.example/navy.jpg', 'https://images.example/green.jpg'];
  const rows = parseCsvText(buildEbayTemplateCsv([p], template, { markupPct: 0, ebayFeePct: 0, roundTo99: false }));
  const headers = rows[1];
  const col = (name) => headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '') === name);
  const data = rows.filter((row) => row[col('Action')] === 'Add');
  assert.equal(data.length, 2);
  assert.equal(data[0][col('C:Height')], 'Regular');
  assert.equal(data[1][col('C:Height')], 'Tall');
  assert.equal(data[1][col('CustomLabel')], 'GREEN');
  assert.equal(data[1][col('StartPrice')], '160.00');
  assert.equal(data[0][col('PicURL')], 'https://images.example/navy.jpg|https://images.example/green.jpg');
  assert.equal(data[1][col('PicURL')], 'https://images.example/green.jpg|https://images.example/navy.jpg');
  assert.ok(!data.some((row) => row[col('PicURL')].includes('source.example')));
});

test('seller country is explicit per SKU and does not inherit US when the seller leaves it blank', () => {
  const pillow = normalizeRecord(throwPillow).product;
  for (const [input, expected] of [[' gb ', 'GB'], ['', '']]) {
    const rows = parseCsvText(buildEbayTemplateCsv([pillow], template, {
      markupPct: 0, ebayFeePct: 0, roundTo99: false, ebayCountry: input,
    }));
    const headers = rows[1];
    assert.doesNotMatch(headers[0], /Country=/);
    assert.match(headers[0], /SiteID=US\|Currency=USD/);
    const countryIndex = headers.indexOf('Country');
    assert.ok(countryIndex >= 0);
    for (const row of rows.filter((row) => row[0] === 'Add')) assert.equal(row[countryIndex], expected);
  }
  assert.match(template.headers[0], /Country=US/, 'source template is never mutated');
});

test('buildEbayTemplateCsv: bàn Cavern — Item Height/Width/Length từ Dimensions, Type để trống', () => {
  const product = normalizeRecord(cavern).product;
  const csv = buildEbayTemplateCsv([product], template, { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  const rows = parseCsvText(csv);
  const col = (name) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '') === name);
  const r = rows[2 + template.infoRows.length];
  assert.equal(r[col('C:Type')], '');
  assert.equal(r[col('C:Item Height')], '18 in');
  assert.equal(r[col('C:Item Width')], '20 in');
  assert.equal(r[col('C:Item Length')], '20 in');
  assert.equal(r[col('C:Item Weight')], '33.1 lb');
  assert.equal(r[col('C:Material')], 'Ash Wood, MDF, cement board, Grey Pesco Marble');
  assert.equal(r[col('StartPrice')], '1470.00');
  assert.equal(r[col('ShippingProfileName')], '', 'profile ship/return/payment để trống — team điền trước khi upload');
});

test('parseBulkList: "url | chủ đề", trùng và dòng lỗi', () => {
  const { items, invalid } = parseBulkList(
    'https://www.sohohome.com/us/products/cavern-side-table | Bàn ghế\n' +
    'https://www.sohohome.com/us/products/catherine-rug-navy-round\n' +
    'https://www.sohohome.com/us/products/cavern-side-table | Bàn ghế\n' +
    'not-a-url\n',
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].theme, 'Bàn ghế');
  assert.equal(items[1].theme, null);
  assert.deepEqual(invalid, ['not-a-url']);
});

test('parseSheetCsv: tìm cột EBAY + TYPE + COST trong file xuất từ sheet', () => {
  const csv = 'TYPE,SOLD,ACCOUNT,NGÁCH BRAND,TITLE,EBAY,COST,QTY\n' +
    ',,T1106LKIM02,SohoHome,Soho Home Dax,https://www.sohohome.com/us/products/dax-chair,$395.00,1\n' +
    'Gối,,,SohoHome,Soho Home Pillow,https://www.sohohome.com/us/products/pillow,$170.00,1\n' +
    ',,,,No link here,,,\n';
  const { items, invalid } = parseSheetCsv(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://www.sohohome.com/us/products/dax-chair');
  assert.equal(items[0].cost, 395);
  assert.equal(items[0].theme, null, 'TYPE trống thì theme null, nhóm theo từ khoá tiêu đề');
  assert.equal(items[1].theme, 'Gối');
  assert.equal(items[1].cost, 170);
  assert.equal(invalid.length, 0);
});

test('sanitizeEbayDescription: bỏ script, link ngoài, ảnh trong mô tả', () => {
  const out = sanitizeEbayDescription('<div onclick="x()">Hi</div><script>alert(1)</script><a href="https://evil.com">click</a><img src="https://x/1.jpg">');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('evil.com'));
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('Hi'));
  assert.ok(out.includes('click'));
});
