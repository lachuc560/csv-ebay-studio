import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseEbaySoldCount, parseEbayItemId, parseEbayWatchers,
  buildResearchGroupedCsvs, RESEARCH_CSV_HEADERS, sourceProductIdFromUrl,
  normalizeRecord, groupProductsByTheme,
} from '../public/core.js';
import {
  buildAiExtractPagePrompt, normalizeAiExtractedPage, ruleBasedExtractPage,
  extractPageWithRuntime, extractPagesWithRuntime, extractPageRecord,
} from '../server/ai.mjs';
import { AiRuntime } from '../server/ai-providers.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf-8');

// ---- Trang Soho Home giả lập: 2 biến thể màu + size ------------------------
// (dữ liệu reader giống thật: JSON-LD non-member $395, specs có Dimensions
// + Material, text trang có tên màu/size để kiểm chứng chống bịa).
const SOHO_IMG = 'https://assets.sohohome.com/images/original/219835-79996850-listingjpg.jpg';
function makeSohoRaw() {
  return {
    url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
    sourceSite: 'sohohome.com',
    sourceProductId: 'daxton-square-cushion-79996850',
    brand: 'Soho Home',
    title: 'Soho Home Daxton Square Cushion',
    price: 395,
    currency: 'USD',
    images: [SOHO_IMG],
    description: 'Square cushion woven in Italy from a viscose, cotton and polyester jacquard.',
    specs: { Dimensions: 'H50 x W50 x D12cm / H20 x W20 x D5"', Material: '42% Viscose, 40% Cotton, 18% Polyester' },
    attributes: {},
    variants: [
      { options: { Color: 'Olive', Size: '20 x 20 in' }, price: 395, in_stock: true },
      { options: { Color: 'Rust', Size: '20 x 20 in' }, price: 395, in_stock: false },
    ],
    pageText: 'Daxton Square Cushion Olive Rust 20 x 20 in woven in Italy viscose cotton polyester jacquard Dimensions H50 x W50 x D12cm $395',
  };
}

function llmExtractJson() {
  return {
    title: 'Soho Home Daxton Square Cushion Italian Jacquard Feather Inner Pad',
    price: 395,
    currency: 'USD',
    images: [SOHO_IMG],
    description: 'Square cushion woven in Italy from viscose, cotton and polyester jacquard.',
    material: 'Viscose jacquard',
    dimensions: 'H50 x W50 x D12cm',
    variants: [
      { color: 'Olive', size: '20 x 20 in', price: 395, stock: true },
      { color: 'Rust', size: '20 x 20 in', price: 395, stock: false },
    ],
  };
}

// Mock AiRuntime (provider openai) trả JSON LLM cho trước.
function mockRuntime(json, { status = 200 } = {}) {
  const rt = new AiRuntime();
  rt.setMemoryConfig({ provider: 'openai', model: 'test-model', apiKey: 'test-key' });
  rt.fetchFn = async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }) });
  return rt;
}

// ---- (a) extract-page với mock LLM: 2 biến thể màu + size -------------------

test('v9 (a): extract-page mock LLM — variants đúng, size/màu lấy từ trang gốc', async () => {
  const raw = makeSohoRaw();
  const rt = mockRuntime(llmExtractJson());
  const { extracted, warnings, provider } = await extractPageWithRuntime(raw, rt);
  assert.equal(provider, 'openai');
  assert.equal(extracted.title, 'Soho Home Daxton Square Cushion Italian Jacquard Feather Inner Pad');
  assert.ok(extracted.title.length <= 80, 'title cắt ≤80 ký tự');
  assert.equal(extracted.price, 395, 'giá non-member từ trang gốc');
  assert.equal(extracted.currency, 'USD');
  assert.deepEqual(extracted.images, [SOHO_IMG]);
  assert.equal(extracted.material, 'Viscose jacquard');
  assert.equal(extracted.dimensions, 'H50 x W50 x D12cm');
  assert.equal(extracted.variants.length, 2);
  assert.deepEqual(extracted.variants[0], { color: 'Olive', size: '20 x 20 in', price: 395, stock: true, options: raw.variants[0].options });
  assert.deepEqual(extracted.variants[1], { color: 'Rust', size: '20 x 20 in', price: 395, stock: false, options: raw.variants[1].options });
  assert.deepEqual(warnings, [], 'đủ dữ liệu thì không có warning');
});

test('v9 (a): POST /api/ai/extract-page lưu thành sản phẩm (mock LLM)', async () => {
  const store = new MemoryStore();
  const raw = makeSohoRaw();
  const rt = mockRuntime(llmExtractJson());
  const { status, json } = await handleRequest(store, {
    method: 'POST',
    path: '/api/ai/extract-page',
    body: { url: raw.url, sourceSite: raw.sourceSite, sourceProductId: raw.sourceProductId, raw },
  }, { aiRuntime: rt });
  assert.equal(status, 200);
  assert.ok(json.product, 'trả về product đã lưu');
  assert.equal(json.product.title, 'Soho Home Daxton Square Cushion Italian Jacquard Feather Inner Pad');
  assert.equal(json.product.variants.length, 2, '2 biến thể màu/size từ trang gốc');
  assert.equal(json.product.variants[0].options.Color, 'Olive');
  assert.equal(json.product.variants[0].options.Size, '20 x 20 in');
  assert.equal(json.product.price, 395);
  assert.equal(json.provider, 'openai');
  const stored = await store.getProduct(json.product.id);
  assert.ok(stored, 'sản phẩm đã lưu trong store');
});

test('v9 (a): extractPageRecord dựng đúng shape normalizeRecord (variants Color/Size)', () => {
  const raw = makeSohoRaw();
  const { extracted } = normalizeAiExtractedPage(llmExtractJson(), raw);
  const record = extractPageRecord(raw, extracted);
  const { product, errors } = normalizeRecord(record);
  assert.deepEqual(errors, []);
  assert.equal(product.variants.length, 2);
  assert.equal(product.variants[1].options.Color, 'Rust');
  assert.equal(product.variants[1].in_stock, false);
  assert.equal(product.price, 395);
});

test('v9 (a): prompt extract-page yêu cầu JSON có variants + không bịa giá', () => {
  const { system } = buildAiExtractPagePrompt(makeSohoRaw());
  assert.ok(system.includes('variants'), 'prompt yêu cầu variants');
  assert.ok(/không bịa/i.test(system), 'prompt cấm bịa');
  assert.ok(/non-member/i.test(system), 'prompt nhắc giá non-member');
});

// ---- (b) trang thiếu giá/mô tả -> null + warning, không bịa -----------------

test('v9 (b): trang thiếu giá/mô tả — các trường đó null + warning, không bịa', async () => {
  const raw = {
    url: 'https://www.sohohome.com/us/products/mystery-item',
    sourceSite: 'sohohome.com',
    sourceProductId: 'mystery-item',
    brand: 'Soho Home',
    title: 'Soho Home Mystery Item',
    price: null,
    currency: 'USD',
    images: [],
    description: null,
    specs: {},
    attributes: {},
    variants: [],
    pageText: 'Mystery Item',
  };
  // LLM cố bịa giá + ảnh + màu không có trên trang.
  const rt = mockRuntime({
    title: 'Soho Home Mystery Item',
    price: 999,
    currency: 'USD',
    images: ['https://example.com/fake.jpg'],
    description: 'A wonderful product.',
    material: null,
    dimensions: null,
    variants: [{ color: 'Emerald', size: '99 x 99 in', price: 999, stock: true }],
  });
  const { extracted, warnings } = await extractPageWithRuntime(raw, rt);
  assert.equal(extracted.price, null, 'giá LLM bịa khi trang không ghi giá -> null');
  assert.deepEqual(extracted.images, [], 'ảnh LLM bịa (không có trong dữ liệu trang) -> bỏ hết');
  assert.equal(extracted.description, 'A wonderful product.', 'mô tả LLM viết từ text trang thì giữ');
  assert.equal(extracted.variants.length, 0, 'biến thể màu/size bịa (không có trên trang) -> bỏ');
  assert.ok(warnings.some((w) => /không ghi giá/i.test(w)), 'có warning thiếu giá');
  assert.ok(warnings.some((w) => /Màu "Emerald"/i.test(w)), 'có warning màu bịa');
  assert.ok(warnings.some((w) => /Size "99 x 99 in"/i.test(w)), 'có warning size bịa');
});

test('v9 (b): không có key AI — trích xuất theo luật, không bịa giá', async () => {
  const raw = makeSohoRaw();
  delete raw.price;
  raw.variants = [];
  const rt = new AiRuntime(); // chưa cấu hình key
  const { extracted, warnings, provider } = await extractPageWithRuntime(raw, rt);
  assert.equal(provider, 'rule-based');
  assert.equal(extracted.price, null, 'không có giá thì null, không đoán');
  assert.ok(warnings.some((w) => /không ghi giá/i.test(w)));
  assert.ok(warnings.some((w) => /Chưa có key AI/i.test(w)));
});

test('v9 (b): ruleBasedExtractPage lấy size/màu từ options reader, không bịa', () => {
  const { extracted } = ruleBasedExtractPage(makeSohoRaw());
  assert.equal(extracted.variants.length, 2);
  assert.equal(extracted.variants[0].color, 'Olive');
  assert.equal(extracted.variants[0].size, '20 x 20 in');
  assert.equal(extracted.price, 395);
});

test('AI cannot replace source SKU combinations, prices, stock or currency', async () => {
  const raw = makeSohoRaw();
  raw.currency = 'GBP';
  raw.variants = [
    { options: { Color: 'Olive', Size: 'S', Height: 'Tall' }, price: 395, compareAt: 450, currency: 'GBP', in_stock: true, stock_qty: 3, sku: 'SKU-OLIVE', upc: '000123456789', image: SOHO_IMG },
    { options: { Color: 'Rust', Size: 'M', Height: 'Regular' }, price: 420, currency: 'GBP', in_stock: false, stock_qty: 0, sku: 'SKU-RUST' },
  ];
  const llm = llmExtractJson();
  // Each value exists somewhere on the page, but this pairing does not.
  llm.variants = [{ color: 'Olive', size: 'M', price: 420, stock: true, sku: 'AI-SKU' }];
  const { extracted, warnings } = await extractPageWithRuntime(raw, mockRuntime(llm));
  assert.equal(extracted.currency, 'GBP');
  assert.ok(warnings.some((w) => /Tiền tệ AI/.test(w)));
  assert.equal(extracted.variants.length, 2);
  assert.deepEqual(extracted.variants.map((v) => [v.options, v.price, v.stock, v.sku]), raw.variants.map((v) => [v.options, v.price, v.in_stock, v.sku]));
  const record = extractPageRecord(raw, extracted);
  assert.equal(record.variants[0].upc, '000123456789');
  assert.equal(record.variants[0].stock_qty, 3);
  assert.equal(record.variants[0].image, SOHO_IMG);
  assert.equal(record.variants[0].compare_at_price, 450);
  assert.equal(record.variants[1].compare_at_price, null, 'do not copy another SKU comparison price');
  assert.equal(record.variants[1].currency, 'GBP');
  assert.equal(record.variants[1].in_stock, false);
});

test('AI extraction retains source variants beyond the 20 sent to the prompt', async () => {
  const raw = makeSohoRaw();
  raw.variants = Array.from({ length: 25 }, (_, i) => ({ options: { Size: `Size ${i}` }, price: 100 + i, in_stock: true, sku: `SKU-${i}` }));
  const llm = llmExtractJson();
  llm.variants = [{ size: 'Size 0', color: null, price: 100, stock: true }];
  const { extracted } = await extractPageWithRuntime(raw, mockRuntime(llm));
  assert.equal(extracted.variants.length, 25);
  assert.equal(extracted.variants[24].sku, 'SKU-24');
  assert.equal(extracted.variants[24].price, 124);
});

test('rule-based extraction retains legacy options, unknown stock and crawl warnings', () => {
  const raw = makeSohoRaw();
  raw.option_names = ['Size', 'Color', 'Height'];
  raw.flags = { price_estimated: true };
  raw.crawl_truncated = true;
  raw.variants = [{ size: 'M', color: 'Blue', extra_options: { Height: 'Tall' }, sku: 'SOURCE-SKU', upc: '000123456789', currency: 'USD', price: 395, in_stock: null }];
  const { extracted } = ruleBasedExtractPage(raw);
  assert.equal(extracted.variants[0].stock, null);
  assert.deepEqual(extracted.variants[0].options, { Height: 'Tall', Color: 'Blue', Size: 'M' });
  const record = extractPageRecord(raw, extracted);
  assert.equal(record.variants[0].in_stock, null);
  assert.equal(record.variants[0].sku, 'SOURCE-SKU');
  assert.equal(record.variants[0].upc, '000123456789');
  assert.deepEqual(record.options, raw.option_names);
  assert.deepEqual(record.flags, raw.flags);
  assert.equal(record.crawl_truncated, true);
});

test('AI-extracted availability without structured source evidence stays unknown', () => {
  const raw = makeSohoRaw();
  raw.variants = [];
  const { extracted } = normalizeAiExtractedPage(llmExtractJson(), raw);
  assert.equal(extracted.variants[0].stock, null);
  assert.equal(extractPageRecord(raw, extracted).variants[0].in_stock, null);
});

test('source option names survive compatibility color/size fields without duplication', () => {
  const raw = makeSohoRaw();
  raw.variants = [{ options: { Colour: 'Olive', size: 'S', Fit: 'Tall' }, color: 'Olive', size: 'S', price: 395, in_stock: true }];
  const { extracted } = ruleBasedExtractPage(raw);
  assert.equal(extracted.variants[0].color, 'Olive');
  assert.equal(extracted.variants[0].size, 'S');
  assert.deepEqual(extractPageRecord(raw, extracted).variants[0].options, raw.variants[0].options);
});

test('extract-page API preserves source metadata and unknown stock end to end', async () => {
  const raw = makeSohoRaw();
  raw.flags = { price_estimated: true };
  raw.crawl_truncated = true;
  raw.variants = [{ options: {}, price: 395, currency: 'GBP', in_stock: null, sku: 'SINGLE-SKU', upc: '000123456789', image: SOHO_IMG }];
  raw.currency = 'GBP';
  const store = new MemoryStore();
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/extract-page', body: { raw },
  }, { aiRuntime: null });
  assert.equal(status, 200);
  const variant = json.product.variants[0];
  assert.equal(variant.sku, 'SINGLE-SKU');
  assert.equal(variant.upc, '000123456789');
  assert.equal(variant.image, SOHO_IMG);
  assert.equal(variant.currency, 'GBP');
  assert.equal(variant.in_stock, null);
  assert.equal(json.product.price_estimated, true);
  assert.equal(json.product.truncated, true);
});

// ---- (c) parse "1,234 sold" từ HTML listing eBay ----------------------------

test('v9 (c): parseEbaySoldCount — "1,234 sold" -> 1234', () => {
  assert.equal(parseEbaySoldCount('1,234 sold'), 1234);
  assert.equal(parseEbaySoldCount('<span>1,234 sold</span>'), 1234);
  assert.equal(parseEbaySoldCount('About this product 12 sold More than 10 available'), 12);
  assert.equal(parseEbaySoldCount('1.234 sold'), 1234, 'dấu chấm hàng nghìn');
  assert.equal(parseEbaySoldCount('No items sold yet'), null);
  assert.equal(parseEbaySoldCount(''), null);
  assert.equal(parseEbaySoldCount(null), null);
});

test('v9 (c): parseEbaySoldCount từ HTML listing eBay giả lập', () => {
  const html = '<html><body><div class="ux-labels-values"><span>1,234 sold</span></div><div>2,500+ sold</div></body></html>';
  assert.equal(parseEbaySoldCount(html), 1234, 'lấy số đầu tiên');
});

test('v9 (c): parseEbayItemId từ link listing eBay', () => {
  assert.equal(parseEbayItemId('https://www.ebay.com/itm/Soho-Home-Daxton-Cushion/123456789012'), '123456789012');
  assert.equal(parseEbayItemId('https://www.ebay.com/itm/123456789012'), '123456789012');
  assert.equal(parseEbayItemId('https://www.ebay.com/itm/abc?item=123456789012'), '123456789012');
  assert.equal(parseEbayItemId('123456789012'), '123456789012', 'dán thẳng mã số');
  assert.equal(parseEbayItemId('https://www.sohohome.com/us/products/daxton'), null, 'không phải link eBay');
  assert.equal(parseEbayItemId(''), null);
});

test('v9 (c): PUT /api/products/:id lưu ebaySold + ebayItemId + ebayWatchers', async () => {
  const store = new MemoryStore();
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_product_id: 'daxton-square-cushion',
    title: 'Soho Home Daxton Square Cushion',
    variants: [{ options: {}, price: 395, in_stock: true }],
  });
  await store.putProduct(product);
  const { status, json } = await handleRequest(store, {
    method: 'PUT',
    path: `/api/products/${product.id}`,
    body: { ebaySold: 1234, ebayItemId: '123456789012', ebayWatchers: 87, ebayWatchersSource: 'WatchCount (nhập tay)', version: 1 },
  });
  assert.equal(status, 200);
  assert.equal(json.product.ebaySold, 1234);
  assert.equal(json.product.ebayItemId, '123456789012');
  assert.equal(json.product.ebayWatchers, 87);
  assert.equal(json.product.ebayWatchersSource, 'WatchCount (nhập tay)');
  // PUT sai version -> 409, không ghi đè.
  const conflict = await handleRequest(store, {
    method: 'PUT',
    path: `/api/products/${product.id}`,
    body: { ebaySold: 1, version: 1 },
  });
  assert.equal(conflict.status, 409);
});

test('v9 (c): parseEbayWatchers — số nhập tay, sai thì null', () => {
  assert.equal(parseEbayWatchers('87'), 87);
  assert.equal(parseEbayWatchers('1,234'), 1234);
  assert.equal(parseEbayWatchers(''), null);
  assert.equal(parseEbayWatchers('abc'), null);
  assert.equal(parseEbayWatchers('-5'), null);
});

test('v9 (c): sourceProductIdFromUrl suy mã từ URL Soho Home', () => {
  assert.equal(sourceProductIdFromUrl('https://www.sohohome.com/us/products/daxton-square-cushion/79996850'), 'daxton-square-cushion-79996850');
  assert.equal(sourceProductIdFromUrl('https://www.amazon.com/dp/B0XXXX'), 'B0XXXX');
  assert.equal(sourceProductIdFromUrl('not a url'), null);
});

// ---- research CSV (v9) ------------------------------------------------------

test('v9: buildResearchGroupedCsvs — 1 file/nhóm, đủ 7 cột, có BOM', () => {
  const { product: p1 } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'daxton-square-cushion',
    title: 'Soho Home Daxton Square Cushion', variants: [{ options: { Color: 'Olive' }, price: 395, in_stock: true }],
  });
  p1.ebaySold = 1234; p1.ebayWatchers = 87; p1.category_id = '20563';
  const { product: p2 } = normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'renato-wall-light',
    title: 'Soho Home Renato Wall Light', variants: [{ options: {}, price: 245, in_stock: true }],
  });
  const { files, skipped } = buildResearchGroupedCsvs([p1, p2], {});
  assert.equal(skipped.length, 0);
  assert.equal(files.length, 2, 'gối + đèn = 2 nhóm');
  // Gối đã có category_id 20563 nên nhóm theo mã danh mục (cat-20563),
  // giống cách nhóm khi xuất CSV upload.
  const cushionFile = files.find((f) => f.csv.includes('Daxton'));
  assert.equal(cushionFile.filename, 'research-cat-20563.csv');
  assert.ok(cushionFile.csv.startsWith('\uFEFF'), 'file research có BOM UTF-8');
  const lines = cushionFile.csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.deepEqual(lines[0].split(','), RESEARCH_CSV_HEADERS);
  assert.ok(lines[1].includes('Daxton Square Cushion'), 'dòng gối có Title');
  assert.ok(lines[1].includes('1234'), 'dòng gối có Đã bán');
  assert.ok(lines[1].includes('87'), 'dòng gối có Người theo dõi');
  assert.ok(lines[1].includes('20563'), 'dòng gối có CategoryId');
  const lampFile = files.find((f) => f.groupKey === 'lighting');
  assert.ok(lampFile.csv.includes('Renato Wall Light'));
});

// ---- (d) KHÔNG có lần gọi HTTP nào tới WatchCount ---------------------------
// WatchCount chỉ được nhắc tên để seller nhập tay số watchers; code KHÔNG
// được fetch/cào watchcount.com (robots.txt của họ cấm bot, không có API
// công khai). Test quét toàn bộ code (server/, public/, extension/src/,
// scripts/) tìm domain watchcount — file test này được loại trừ vì nó chứa
// chuỗi cần tìm để kiểm tra.
test('v9 (d): không có lần gọi HTTP nào tới watchcount trong code', () => {
  const roots = ['server', 'public', 'extension/src', 'scripts'];
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|js|html|css|json|md)$/.test(entry)) continue;
      const content = readFileSync(full, 'utf-8');
      if (/watchcount\.com/i.test(content)) bad.push(full);
      if (/fetch\s*\(\s*['"`][^'"`]*watchcount/i.test(content)) bad.push(`${full} (fetch)`);
    }
  };
  for (const r of roots) walk(`${root}${r}`);
  assert.deepEqual(bad, [], 'code không được chứa domain watchcount (không fetch, không cào)');
});

// ---- (e) rate limit 429 dừng bulk extract -----------------------------------

test('v9 (e): 429 dừng bulk extract — trang sau 429 dùng luật, stopped429=true', async () => {
  const rt = new AiRuntime();
  rt.setMemoryConfig({ provider: 'openai', model: 'test-model', apiKey: 'test-key' });
  let calls = 0;
  rt.fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(llmExtractJson()) } }] }) };
    }
    if (calls === 2) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    throw new Error('không được gọi LLM nữa sau 429');
  };
  const pages = [makeSohoRaw(), makeSohoRaw(), makeSohoRaw()];
  const { results, stopped429, provider } = await extractPagesWithRuntime(pages, rt);
  assert.equal(results.length, 3);
  assert.equal(stopped429, true, 'gặp 429 thì dừng gọi LLM');
  assert.equal(results[0].provider, 'openai', 'trang 1 dùng LLM');
  assert.equal(results[1].provider, 'rule-based', 'trang 2 (429) fallback luật');
  assert.equal(results[1].rateLimited, true);
  assert.equal(results[2].provider, 'rule-based', 'trang 3 sau 429 không gọi LLM nữa');
  assert.equal(results[2].extracted.variants.length, 2, 'trang 3 vẫn có biến thể từ dữ liệu trang (luật)');
  assert.equal(calls, 2, 'chỉ 2 lần gọi LLM (trang 1 + trang 2 gặp 429)');
  assert.equal(provider, 'openai');
});

test('v9 (e): POST /api/ai/extract-page hàng loạt gặp 429 -> stopped429', async () => {
  const store = new MemoryStore();
  const rt = new AiRuntime();
  rt.setMemoryConfig({ provider: 'openai', model: 'test-model', apiKey: 'test-key' });
  let calls = 0;
  rt.fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(llmExtractJson()) } }] }) };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
  const pages = [makeSohoRaw(), makeSohoRaw()];
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/extract-page', body: { pages },
  }, { aiRuntime: rt });
  assert.equal(status, 200);
  assert.equal(json.stopped429, true);
  assert.equal(json.results.length, 2);
  assert.ok(json.results[0].product, 'trang 1 lưu được sản phẩm');
  assert.ok(json.results[1].product, 'trang 2 (429) vẫn lưu được sản phẩm theo luật');
  assert.equal(calls, 2);
});

test('v9 (e): extract-page thiếu url -> 400 url_required', async () => {
  const store = new MemoryStore();
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/extract-page', body: { raw: {} },
  }, { aiRuntime: new AiRuntime() });
  assert.equal(status, 400);
  assert.equal(json.error, 'url_required');
});
