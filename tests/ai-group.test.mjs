// tests/ai-group.test.mjs — AI gom nhóm sản phẩm giống nhau (v6).
// POST /api/ai/group: LLM gom các sản phẩm cùng loại vào chung 1 nhóm,
// mỗi nhóm xuất 1 file CSV riêng. Không gọi LLM thật trong test — mock
// fetch như tests/ai-providers.test.mjs. Key thật không có trong file này.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EBAY_TYPES_20563, parseEbayTemplate, normalizeRecord, parseSheetCsv,
  productFromSheetItem, groupProductsByTheme, groupProductsByAiAssignments,
  buildGroupedEbayCsvs, autoSheetToCsv,
} from '../public/core.js';
import { AiRuntime, extractJsonArray } from '../server/ai-providers.mjs';
import {
  buildAiGroupPrompt, canonicalGroupKey, normalizeAiGroupAssignments,
  ruleBasedGroupAssignments, groupProductsWithAi, groupWithRuntime,
  AI_GROUP_BATCH_SIZE, UNCLASSIFIED_GROUP_KEY,
} from '../server/ai.mjs';
import { MemoryStore, handleRequest } from '../server/api.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const template = parseEbayTemplate(readFileSync(path.join(root, 'public', 'templates', 'ebay-20563.csv'), 'utf-8'));
const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };
const okJson = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}

function makeProduct(overrides) {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: `https://www.sohohome.com/us/products/${overrides.id}`,
    source_product_id: overrides.id,
    brand: 'Soho Home',
    title: overrides.title,
    description_text: overrides.description ?? '',
    images: ['https://assets.sohohome.com/x.jpg'],
    specs: overrides.specs ?? {},
    variants: [{ options: {}, price: overrides.price ?? 300, in_stock: true }],
  });
  return product;
}

const cushion = () => makeProduct({ id: 'daxton-square-cushion', title: 'Soho Home Daxton Square Cushion', description: 'Square cushion woven in Italy from jacquard with a feather inner pad.', specs: { Material: 'Viscose jacquard' } });
// Tên KHÔNG chứa từ khoá loại ("Dax") nhưng mô tả nói rõ là gối.
const dax = () => makeProduct({ id: 'dax', title: 'Soho Home Dax', description: 'A decorative cushion with jacquard fabric and feather inner pad.' });
const lamp = () => makeProduct({ id: 'archie-table-lamp', title: 'Soho Home Archie Table Lamp', description: 'Table lamp with linen shade and brass base.' });
const mirror = () => makeProduct({ id: 'betty-mirror-short', title: 'Soho Home Betty Wall Mirror, Antique Brass', description: 'Wall mirror with antique brass frame.' });
const toilet = () => makeProduct({ id: 'charlton-toilet-roll-holder-brass', title: 'Soho Home Charlton Toilet Roll Holder, Brass', description: 'Wall-mounted toilet roll holder in polished brass.' });

/** Mock LLM gom nhóm: đọc mô tả/tên trong prompt, gom theo loại thật. */
function mockGroupLlm() {
  return async (_system, user) => {
    const list = JSON.parse(user);
    return list.map((p) => {
      const hay = `${p.title} ${p.description ?? ''}`.toLowerCase();
      if (hay.includes('cushion') || hay.includes('pillow')) {
        return { productId: p.id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Cushion' };
      }
      if (hay.includes('lamp') || hay.includes('light')) {
        return { productId: p.id, groupKey: 'table-lamps', groupLabel: 'Table Lamps', ebayType: null };
      }
      if (hay.includes('mirror')) {
        return { productId: p.id, groupKey: 'wall-mirrors', groupLabel: 'Wall Mirrors', ebayType: null };
      }
      return { productId: p.id, groupKey: 'bathroom-brass', groupLabel: 'Bathroom Brass', ebayType: null };
    });
  };
}

// ---- prompt + chuẩn hoá groupKey -------------------------------------------

test('extractJsonArray: mảng trần, fence ```json, text thừa; object thì lỗi (không cắt nhầm thành object đầu)', () => {
  assert.deepEqual(extractJsonArray('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('Đây là kết quả:\n[{"a":1}]\nHết.'), [{ a: 1 }]);
  assert.throws(() => extractJsonArray('{"a":1}'), /mảng JSON/);
  assert.throws(() => extractJsonArray('không có json'), /mảng JSON/);
});

test('buildAiGroupPrompt: gửi id/title/mô tả ≤300 ký tự, yêu cầu mảng JSON, liệt kê 22 Type', () => {
  const long = makeProduct({ id: 'long', title: 'Soho Home Long', description: 'x'.repeat(1000) });
  const { system, user } = buildAiGroupPrompt([cushion(), long]);
  assert.match(system, /MỘT mảng JSON/);
  assert.match(system, /cushions/);
  assert.match(system, /22 giá trị/);
  const list = JSON.parse(user);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, cushion().id);
  assert.ok(list[1].description.length <= 300, 'mô tả gửi LLM tối đa 300 ký tự');
  assert.match(user, /Daxton Square Cushion/);
});

test('canonicalGroupKey: biến thể gối gộp về cushions, khoá khác giữ nguyên', () => {
  assert.equal(canonicalGroupKey('throw-pillows'), 'cushions');
  assert.equal(canonicalGroupKey('Square Cushions'), 'cushions');
  assert.equal(canonicalGroupKey('pillow-covers'), 'cushions');
  assert.equal(canonicalGroupKey('table-lamps'), 'table-lamps');
  assert.equal(canonicalGroupKey('wall-mirrors'), 'wall-mirrors');
  assert.equal(canonicalGroupKey(''), '');
});

// ---- kiểm chứng kết quả gom nhóm --------------------------------------------

test('normalizeAiGroupAssignments: mảng đúng -> đủ assignment, Type gối giữ, nhóm khác null', () => {
  const products = [cushion(), lamp(), mirror()];
  const raw = [
    { productId: products[0].id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Throw Pillow' },
    { productId: products[1].id, groupKey: 'table-lamps', groupLabel: 'Table Lamps', ebayType: 'Cushion' },
    { productId: products[2].id, groupKey: 'wall-mirrors', groupLabel: 'Wall Mirrors', ebayType: null },
  ];
  const { assignments, warnings, unclassified } = normalizeAiGroupAssignments(raw, products);
  assert.equal(assignments.length, 3);
  assert.deepEqual(unclassified, []);
  assert.equal(assignments[0].ebayType, 'Throw Pillow');
  assert.equal(assignments[1].ebayType, null, 'nhóm đèn không cần Type — bỏ ebayType');
  assert.ok(warnings.some((w) => w.includes('không phải gối')));
});

test('normalizeAiGroupAssignments: productId lạ / thiếu sản phẩm / groupKey rỗng -> chưa phân loại + warning, không bỏ im lặng', () => {
  const products = [cushion(), lamp(), mirror(), toilet()];
  const raw = [
    { productId: 'san-pham-la', groupKey: 'cushions', groupLabel: 'Cushions', ebayType: null },
    { productId: products[0].id, groupKey: 'throw-pillows', groupLabel: 'Throw Pillows', ebayType: 'Velvet Pillow' },
    { productId: products[1].id, groupKey: '', groupLabel: '', ebayType: null },
    { productId: products[1].id, groupKey: 'table-lamps', groupLabel: 'Table Lamps', ebayType: null },
  ];
  const { assignments, warnings, unclassified } = normalizeAiGroupAssignments(raw, products);
  assert.equal(assignments.length, 4, 'mỗi sản phẩm đúng 1 assignment, kể cả chưa phân loại');
  assert.ok(warnings.some((w) => w.includes('productId lạ')));
  assert.ok(warnings.some((w) => w.includes('2 nhóm')));
  const byId = new Map(assignments.map((a) => [a.productId, a]));
  assert.equal(byId.get(products[0].id).groupKey, 'cushions', 'throw-pillows chuẩn hoá về cushions');
  assert.equal(byId.get(products[0].id).ebayType, null, 'Type ngoài danh sách -> null + warning');
  assert.equal(byId.get(products[1].id).groupKey, UNCLASSIFIED_GROUP_KEY, 'groupKey rỗng -> chưa phân loại');
  assert.deepEqual(unclassified.sort(), [products[1].id, products[2].id, products[3].id].sort());
  assert.ok(warnings.some((w) => w.includes('không gán nhóm')));
});

test('normalizeAiGroupAssignments: không phải mảng -> throw để caller fallback', () => {
  assert.throws(() => normalizeAiGroupAssignments({ a: 1 }, [cushion()]), /mảng JSON/);
  assert.throws(() => normalizeAiGroupAssignments(null, [cushion()]), /mảng JSON/);
});

test('ruleBasedGroupAssignments: fallback theo từ khoá, gối có Type trong 22 giá trị', () => {
  const products = [cushion(), lamp(), dax()];
  const { assignments } = ruleBasedGroupAssignments(products);
  const byId = new Map(assignments.map((a) => [a.productId, a]));
  assert.equal(byId.get(products[0].id).groupKey, 'cushions');
  assert.equal(byId.get(products[0].id).ebayType, 'Cushion');
  assert.ok(EBAY_TYPES_20563.includes(byId.get(products[0].id).ebayType));
  assert.equal(byId.get(products[1].id).groupKey, 'lighting');
  assert.equal(byId.get(products[1].id).ebayType, null);
  assert.equal(byId.get(products[2].id).groupKey, 'other', 'tên "Dax" không có từ khoá -> theo luật rơi vào Other');
});

// ---- gom nhóm bằng LLM (mock) ------------------------------------------------

test('groupProductsWithAi (mock): 2 gối + 1 đèn + 1 gương -> đúng 3 nhóm, không trộn; "Dax" gom đúng nhờ mô tả', async () => {
  const products = [cushion(), dax(), lamp(), mirror()];
  const result = await groupProductsWithAi(products, mockGroupLlm(), { providerName: 'gemini' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.stopped429, false);
  assert.equal(result.groups.length, 3);
  const byKey = new Map(result.groups.map((g) => [g.key, g]));
  assert.equal(byKey.get('cushions').count, 2);
  assert.deepEqual(byKey.get('cushions').productIds.sort(), [products[0].id, products[1].id].sort());
  assert.equal(byKey.get('table-lamps').count, 1);
  assert.equal(byKey.get('wall-mirrors').count, 1);
  assert.equal(byKey.get('cushions').categoryId, '20563');
  assert.equal(byKey.get('table-lamps').categoryId, null);
  assert.equal(result.unclassified.length, 0);
});

test('groupProductsWithAi: không có key (callLlmJson null) -> fallback rule-based + warning rõ', async () => {
  const result = await groupProductsWithAi([cushion(), lamp()], null);
  assert.equal(result.provider, 'rule-based');
  assert.ok(result.warnings.some((w) => w.includes('Chưa có key AI')));
  assert.equal(result.groups.length, 2);
});

test('groupProductsWithAi: LLM lỗi JSON -> fallback rule-based cho batch đó, không crash', async () => {
  const failing = async () => { throw new Error('LLM không trả JSON hợp lệ'); };
  const result = await groupProductsWithAi([cushion(), lamp()], failing, { providerName: 'gemini' });
  assert.equal(result.provider, 'rule-based');
  assert.equal(result.assignments.length, 2);
  assert.ok(result.warnings.some((w) => w.includes('lỗi')));
  assert.equal(result.groups.length, 2);
});

test('groupProductsWithAi: 429 ở batch 2 -> dừng gọi LLM, giữ kết quả, batch còn lại fallback', async () => {
  const products = [];
  for (let i = 0; i < 25; i++) {
    products.push(i < 20
      ? makeProduct({ id: `cushion-${i}`, title: `Soho Home Cushion ${i}`, description: 'Square cushion with feather pad.' })
      : makeProduct({ id: `lamp-${i}`, title: `Soho Home Lamp ${i}`, description: 'Table lamp with linen shade.' }));
  }
  let calls = 0;
  const flaky = async (system, user) => {
    calls++;
    if (calls === 1) return mockGroupLlm()(system, user);
    throw new Error('AI chạm giới hạn request (HTTP 429) — gói miễn phí Gemini giới hạn khoảng 15 request/phút, đợi 1 phút rồi thử lại');
  };
  const result = await groupProductsWithAi(products, flaky, { providerName: 'gemini' });
  assert.equal(result.stopped429, true);
  assert.equal(result.provider, 'gemini', 'batch 1 đã dùng LLM nên provider vẫn là gemini');
  assert.equal(result.assignments.length, 25, 'không mất sản phẩm nào');
  assert.equal(calls, 2, 'gặp 429 thì không gọi LLM thêm nữa');
  assert.ok(result.warnings.some((w) => w.includes('429')));
  const byKey = new Map(result.groups.map((g) => [g.key, g]));
  assert.equal(byKey.get('cushions').count, 20);
  assert.equal(byKey.get('lighting').count, 5, 'batch 2 fallback theo từ khoá: "Lamp" -> lighting');
});

test('groupProductsWithAi: 429 ngay batch đầu -> provider rule-based, vẫn đủ assignment', async () => {
  const failing429 = async () => { throw new Error('AI chạm giới hạn request (HTTP 429)'); };
  const result = await groupProductsWithAi([cushion(), lamp()], failing429, { providerName: 'gemini' });
  assert.equal(result.stopped429, true);
  assert.equal(result.provider, 'rule-based');
  assert.equal(result.assignments.length, 2);
});

// ---- groupWithRuntime: key thật (mock fetch) ---------------------------------

test('groupWithRuntime (Gemini mock): LLM gom nhóm, provider gemini', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AQ-test', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  const products = [cushion(), lamp()];
  rt.fetchFn = mockFetch((_url, init) => {
    const body = JSON.parse(init.body);
    const list = JSON.parse(body.contents[0].parts[0].text);
    const grouped = list.map((p) => ({
      productId: p.id,
      groupKey: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'cushions' : 'table-lamps',
      groupLabel: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'Cushions & Pillows' : 'Table Lamps',
      ebayType: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'Cushion' : null,
    }));
    return okJson(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(grouped) }] } }] });
  });
  const result = await groupWithRuntime(products, rt);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.groups.length, 2);
  assert.equal(result.assignments[0].groupKey, 'cushions');
});

test('groupWithRuntime: chưa có key -> fallback rule-based, không gọi fetch', async () => {
  const rt = new AiRuntime({ AI_MIN_INTERVAL_MS: '0' });
  let fetchCalls = 0;
  rt.fetchFn = async () => { fetchCalls++; return okJson(200, {}); };
  const result = await groupWithRuntime([cushion(), lamp()], rt);
  assert.equal(result.provider, 'rule-based');
  assert.equal(fetchCalls, 0);
});

// ---- xuất CSV riêng từng nhóm --------------------------------------------------

test('groupProductsByAiAssignments + buildGroupedEbayCsvs: mỗi file chỉ chứa sản phẩm của nhóm đó; nhóm chưa có template không xuất', () => {
  const products = [cushion(), dax(), lamp(), mirror()];
  const assignments = [
    { productId: products[0].id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Cushion' },
    { productId: products[1].id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Cushion' },
    { productId: products[2].id, groupKey: 'table-lamps', groupLabel: 'Table Lamps', ebayType: null },
    { productId: products[3].id, groupKey: 'wall-mirrors', groupLabel: 'Wall Mirrors', ebayType: null },
  ];
  const groups = groupProductsByAiAssignments(products, assignments);
  assert.equal(groups.length, 3);
  const { files, skipped } = buildGroupedEbayCsvs(products, template, config, groups);
  assert.equal(files.length, 1, 'chỉ nhóm gối có template 20563 nên chỉ xuất 1 file');
  assert.equal(files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(files[0].productCount, 2);
  assert.ok(files[0].csv.includes('Daxton Square Cushion'), 'file gối chứa gối Daxton');
  assert.ok(files[0].csv.includes('Soho Home Dax'), 'file gối chứa Dax');
  assert.ok(!files[0].csv.includes('Archie Table Lamp'), 'file gối KHÔNG được chứa đèn');
  assert.ok(!files[0].csv.includes('Betty Wall Mirror'), 'file gối KHÔNG được chứa gương');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((s) => s.key === 'table-lamps' && s.productCount === 1));
  assert.ok(skipped.some((s) => s.key === 'wall-mirrors' && s.productCount === 1));
});

test('groupProductsByTheme: nhóm AI đã lưu (edits.aiGroup) được ưu tiên trước từ khoá', () => {
  const p = dax();
  assert.equal(groupProductsByTheme([p])[0].key, 'other');
  p.edits = { aiGroup: 'cushions', aiGroupLabel: 'Cushions & Pillows' };
  const groups = groupProductsByTheme([p]);
  assert.equal(groups[0].key, 'cushions');
  assert.equal(groups[0].categoryId, '20563');
  assert.equal(groups[0].label, 'Cushions & Pillows');
});

test('autoSheetToCsv với aiAssignments: nhóm theo AI, ghi aiGroup vào edits, chỉ xuất file gối', () => {
  const sheetText = 'TYPE,SOLD,ACCOUNT,FOLDER,NGÁCH BRAND,TITLE,DESCRIPTION,SIZE,EBAY,Site chính,COST,QTY,TOTAL COST,GIÁ BÁN\n' +
    ',,,,SohoHome,Soho Home Daxton Square Cushion,"<div><img src=""https://assets.sohohome.com/images/daxton.jpg""><p>Italian jacquard cushion</p></div>",,https://www.sohohome.com/us/products/daxton-square-cushion/79996850,https://www.sohohome.com/us/products/daxton-square-cushion/79996850,"$395,00",1,"$395,00","$280,00"\n' +
    ',,,,SohoHome,Soho Home Archie Table Lamp,"<div><p>Table lamp</p></div>",,,https://www.sohohome.com/us/products/archie-table-lamp,"$650,00",1,"$650,00","$431,70"\n';
  const records = [
    { source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850', source_product_id: 'daxton-square-cushion', brand: 'Soho Home', title: 'Soho Home Daxton Square Cushion', description_text: 'Square cushion.', images: [], variants: [{ options: {}, price: 395, in_stock: true }] },
    { source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/archie-table-lamp', source_product_id: 'archie-table-lamp', brand: 'Soho Home', title: 'Soho Home Archie Table Lamp', description_text: 'Table lamp.', images: [], variants: [{ options: {}, price: 650, in_stock: true }] },
  ];
  const first = autoSheetToCsv(sheetText, records, template, config);
  const assignments = [
    { productId: first.products[0].id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Throw Pillow' },
    { productId: first.products[1].id, groupKey: 'table-lamps', groupLabel: 'Table Lamps', ebayType: null },
  ];
  const result = autoSheetToCsv(sheetText, records, template, { ...config, aiAssignments: assignments });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(result.products[0].edits.aiGroup, 'cushions');
  assert.equal(result.products[0].edits.aiGroupLabel, 'Cushions & Pillows');
  assert.equal(result.products[0].edits.ebayType, 'Throw Pillow');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].key, 'table-lamps');
});

// ---- fixture sheet thật: nhóm theo từ khoá vẫn ra đúng các nhóm ----------------

test('fixture sheet thật (117 sp): nhóm theo từ khoá ra gối 53, đèn 39, phòng tắm 8, gương 7, ghế 3, giường 2, tủ 1', () => {
  const text = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const { items } = parseSheetCsv(text);
  assert.equal(items.length, 117);
  const products = items.map(productFromSheetItem).filter(Boolean);
  assert.equal(products.length, 113, '4 dòng trống TITLE/COST bị loại');
  const counts = new Map(groupProductsByTheme(products).map((g) => [g.key, g.products.length]));
  assert.equal(counts.get('cushions'), 53);
  assert.equal(counts.get('lighting'), 39);
  assert.equal(counts.get('bath'), 8);
  assert.equal(counts.get('mirrors'), 7);
  assert.equal(counts.get('seating'), 3);
  assert.equal(counts.get('beds'), 2);
  assert.equal(counts.get('storage'), 1);
});

// ---- endpoint POST /api/ai/group ------------------------------------------------

test('POST /api/ai/group (productIds, Gemini mock): trả assignments + groups + sampleTitles', async () => {
  const store = new MemoryStore();
  const products = [cushion(), dax(), lamp()];
  for (const p of products) await store.putProduct(p);
  const rt = new AiRuntime({ AI_API_KEY: 'AQ-test', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  rt.fetchFn = mockFetch((_url, init) => {
    const body = JSON.parse(init.body);
    const list = JSON.parse(body.contents[0].parts[0].text);
    const grouped = list.map((p) => ({
      productId: p.id,
      groupKey: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'cushions' : 'table-lamps',
      groupLabel: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'Cushions & Pillows' : 'Table Lamps',
      ebayType: /cushion/i.test(`${p.title} ${p.description ?? ''}`) ? 'Cushion' : null,
    }));
    return okJson(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(grouped) }] } }] });
  });
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/group',
    body: { productIds: products.map((p) => p.id) },
  }, { aiRuntime: rt });
  assert.equal(status, 200);
  assert.equal(json.provider, 'gemini');
  assert.equal(json.assignments.length, 3);
  assert.equal(json.groups.length, 2);
  const cushions = json.groups.find((g) => g.key === 'cushions');
  assert.equal(cushions.count, 2);
  assert.equal(cushions.categoryId, '20563');
  assert.ok(cushions.sampleTitles.some((t) => t.includes('Dax')), 'sampleTitles có tên mẫu, kể cả sản phẩm tên không có từ khoá');
  assert.deepEqual(json.unclassified, []);
});

test('POST /api/ai/group: không có key -> rule-based; body sai -> 400; >200 sp -> 400; id lạ -> 404', async () => {
  const store = new MemoryStore();
  const p = cushion();
  await store.putProduct(p);
  const rtNoKey = new AiRuntime({ AI_MIN_INTERVAL_MS: '0' });
  const res1 = await handleRequest(store, {
    method: 'POST', path: '/api/ai/group', body: { productIds: [p.id] },
  }, { aiRuntime: rtNoKey });
  assert.equal(res1.status, 200);
  assert.equal(res1.json.provider, 'rule-based');

  const res2 = await handleRequest(store, { method: 'POST', path: '/api/ai/group', body: {} }, { aiRuntime: rtNoKey });
  assert.equal(res2.status, 400);
  assert.equal(res2.json.error, 'products_required');

  const many = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, title: `Product ${i}` }));
  const res3 = await handleRequest(store, { method: 'POST', path: '/api/ai/group', body: { products: many } }, { aiRuntime: rtNoKey });
  assert.equal(res3.status, 400);
  assert.equal(res3.json.error, 'too_many_products');

  const res4 = await handleRequest(store, { method: 'POST', path: '/api/ai/group', body: { productIds: ['id-khong-ton-tai'] } }, { aiRuntime: rtNoKey });
  assert.equal(res4.status, 404);
  assert.equal(res4.json.error, 'not_found');
});
