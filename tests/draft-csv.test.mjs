// tests/draft-csv.test.mjs — File CSV NHÁP riêng từng nhóm chưa có template (v7).
// User không thể đưa hết template từng danh mục: file nháp dùng cấu trúc
// 98 cột của template gối 20563 làm mẫu, điền sẵn cột chung, để trống
// Category + toàn bộ cột C:, tên file có DRAFT, ghi rõ chưa upload được.
// AI chỉ gợi ý tên danh mục (chưa xác minh), KHÔNG ghi vào cột Category.
// Không gọi LLM thật trong test — mock fetch như tests/ai-group.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseEbayTemplate, normalizeRecord, parseSheetCsv, parseCsvText,
  templateColumnIndex, groupProductsByTheme, groupProductsByAiAssignments,
  buildGroupedEbayCsvs, buildDraftTemplateCsv, draftMissingColumns,
  buildDraftGroupedCsvs, autoSheetToCsv, DRAFT_WARNING_TEXT,
} from '../public/core.js';
import { AiRuntime } from '../server/ai-providers.mjs';
import {
  buildAiDraftCategoryPrompt, normalizeDraftCategorySuggestions,
  suggestDraftCategoriesWithRuntime,
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
const lamp = () => makeProduct({ id: 'archie-table-lamp', title: 'Soho Home Archie Table Lamp', description: 'Table lamp with linen shade and brass base.' });
const mirror = () => makeProduct({ id: 'betty-mirror-short', title: 'Soho Home Betty Wall Mirror, Antique Brass', description: 'Wall mirror with antique brass frame.' });
const toilet = () => makeProduct({ id: 'charlton-toilet-roll-holder-brass', title: 'Soho Home Charlton Toilet Roll Holder, Brass', description: 'Wall-mounted toilet roll holder in polished brass.' });

/** Lấy dòng sản phẩm đầu tiên trong CSV file Exchange: quét dòng đầu tiên
 *  có ô đầu là 'Add' (file upload được: dòng 41 sau khối Info; file nháp
 *  v8.1: dòng 3, sau dòng cảnh báo DRAFT — không còn khối Info của gối). */
function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { rows, headers: rows[1], row: rows[firstDataIdx], rowCount: rows.length - firstDataIdx, firstDataIdx };
}
function cell(headers, row, name) {
  const i = templateColumnIndex(headers, name);
  return i >= 0 ? (row[i] ?? '') : undefined;
}

// ---- file nháp: đủ 98 cột, cột chung điền đúng, Category + C: trống --------

test('buildDraftTemplateCsv: đủ 98 cột, cột chung điền đúng, Category + toàn bộ C: để trống', () => {
  const csvText = buildDraftTemplateCsv([lamp()], template, config);
  const { headers, row, rowCount } = firstDataRow(csvText);
  assert.equal(headers.length, 98);
  assert.equal(rowCount, 1);
  assert.equal(cell(headers, row, 'Action'), 'Add');
  assert.equal(cell(headers, row, 'Title'), 'Soho Home Archie Table Lamp');
  assert.equal(cell(headers, row, 'ConditionID'), '1000');
  assert.equal(cell(headers, row, 'Format'), 'FixedPrice');
  assert.equal(cell(headers, row, 'Duration'), 'GTC');
  assert.equal(cell(headers, row, 'StartPrice'), '300.00');
  assert.equal(cell(headers, row, 'Quantity'), '1');
  assert.ok(cell(headers, row, 'PicURL').includes('assets.sohohome.com'), 'PicURL có ảnh chính');
  assert.ok(cell(headers, row, 'CustomLabel'), 'CustomLabel (SKU) có giá trị');
  assert.equal(cell(headers, row, 'Category'), '', 'Category để trống — không ghi 20563 của gối');
  for (const h of headers) {
    const name = String(h).replace(/^\*/, '');
    if (name.startsWith('C:')) {
      assert.equal(cell(headers, row, name), '', `cột ${name} để trống trong file nháp`);
    }
  }
});

// ---- v8.1: file nháp KHÔNG còn dòng Info của gối 20563 ----------------------
// Lỗi user báo 16/11/2026 (ảnh Excel mở ebay-DRAFT-mirrors.csv): v7 để
// nguyên khối Info của template gối trong file nháp — "For categoryId:
// 20563", "required aspects are Type; Brand", danh sách giá trị Type toàn
// loại gối. File nháp chỉ còn: dòng Version, header, ĐÚNG 1 dòng cảnh báo
// DRAFT ngay dưới header, rồi các dòng dữ liệu.

test('buildDraftTemplateCsv (v8.1): không còn chuỗi "20563" ở bất cứ đâu, không còn dòng Info của gối', () => {
  for (const p of [lamp(), mirror()]) {
    const csvText = buildDraftTemplateCsv([p], template, config);
    assert.ok(!csvText.includes('20563'), 'file nháp không được chứa mã 20563 của gối');
    assert.ok(!csvText.includes('For categoryId'), 'không còn dòng "For categoryId" của gối');
    assert.ok(!csvText.includes('required aspects'), 'không còn dòng "required aspects" của gối');
    assert.ok(!csvText.includes('Back Cushion'), 'không còn danh sách giá trị Type của gối');
    assert.ok(!csvText.includes('Bolster'), 'không còn giá trị Type của gối');
  }
});

test('buildDraftTemplateCsv (v8.1): đúng 1 dòng DRAFT ngay dưới header, dòng Version giữ nguyên, không dòng Info nào khác', () => {
  const csvText = buildDraftTemplateCsv([mirror()], template, config);
  const { rows, headers, rowCount } = firstDataRow(csvText);
  // Bố cục: [0] Version, [1] header, [2] DRAFT, [3...] dữ liệu.
  assert.equal(rows[0][0], 'Info', 'dòng Version giữ nguyên');
  assert.ok(String(rows[0][1]).startsWith('Version=1.0.0'));
  assert.deepEqual(headers, template.headers, 'header vẫn 98 cột như template');
  assert.equal(rows[2][0], 'DRAFT', 'dòng cảnh báo ngay dưới header, ô đầu ghi DRAFT');
  assert.equal(rows[2][1], DRAFT_WARNING_TEXT, 'nội dung cảnh báo đúng câu đã chốt');
  assert.ok(!DRAFT_WARNING_TEXT.includes('20563'), 'câu cảnh báo không chứa mã gối');
  const draftRows = rows.filter((r) => r[0] === 'DRAFT');
  assert.equal(draftRows.length, 1, 'chỉ đúng 1 dòng DRAFT');
  const infoRows = rows.filter((r) => r[0] === 'Info');
  assert.equal(infoRows.length, 1, 'chỉ còn đúng 1 dòng bắt đầu bằng Info (dòng Version) — không còn khối Info của gối');
  assert.equal(rowCount, 1, 'số dòng dữ liệu không đổi');
});

test('buildGroupedEbayCsvs (v8.1): file gối upload được VẪN giữ nguyên các dòng Info đúng của 20563', () => {
  const products = [cushion(), lamp(), mirror()];
  const groups = groupProductsByTheme(products);
  const { files } = buildGroupedEbayCsvs(products, template, config, groups);
  assert.equal(files.length, 1);
  const csvText = files[0].csv;
  assert.ok(csvText.includes('20563'), 'file gối vẫn có mã 20563');
  assert.ok(csvText.includes('For categoryId:  20563'), 'file gối vẫn giữ dòng Info categoryId đúng');
  assert.ok(csvText.includes('The required aspects are Type; Brand'), 'file gối vẫn giữ dòng Info required aspects đúng');
  assert.ok(csvText.includes('Back Cushion'), 'file gối vẫn giữ danh sách giá trị Type của gối');
  const { headers, row } = firstDataRow(csvText);
  assert.equal(headers.length, 98);
  assert.equal(cell(headers, row, 'Category'), '20563');
});

test('buildDraftTemplateCsv: StartPrice lấy GIÁ BÁN trong sheet khi có', () => {
  const csvText = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const result = autoSheetToCsv(csvText, [], template, config);
  const d = result.draftFiles.find((f) => f.groupKey === 'lighting');
  const { headers, row } = firstDataRow(d.csv);
  // Renato Wall Light: COST $350, GIÁ BÁN $245 trong sheet.
  const renato = result.products.find((p) => (p.title ?? '').includes('Renato Wall Light'));
  assert.ok(renato, 'có sản phẩm Renato trong dữ liệu thật');
  assert.equal(cell(headers, row, 'Title'), 'Soho Home Renato Wall Light');
  assert.equal(cell(headers, row, 'StartPrice'), '245.00');
});

test('draftMissingColumns: liệt kê Category + toàn bộ cột C: + cột shop chưa có; có config thì bỏ cột đó ra', () => {
  const missing = draftMissingColumns(template, config);
  assert.ok(missing.includes('Category'));
  assert.ok(missing.includes('C:Type'));
  assert.ok(missing.includes('C:Brand'));
  assert.ok(missing.includes('C:Color'));
  assert.ok(missing.includes('C:Material'));
  assert.ok(missing.includes('Location'));
  assert.ok(missing.includes('DispatchTimeMax'));
  assert.ok(missing.includes('ReturnsAcceptedOption'));
  assert.ok(missing.includes('ShippingProfileName'));
  assert.ok(!missing.includes('Action'), 'cột chung đã điền thì không liệt kê');
  const withConfig = draftMissingColumns(template, { ...config, ebayLocation: 'New York, NY', dispatchTimeMax: '3' });
  assert.ok(!withConfig.includes('Location'), 'đã có Location trong config thì không liệt kê');
  assert.ok(!withConfig.includes('DispatchTimeMax'));
  assert.ok(withConfig.includes('Category'), 'Category vẫn liệt kê dù có config');
});

// ---- file gối upload được không đổi ------------------------------------------

test('buildGroupedEbayCsvs: file gối vẫn upload được như cũ (Category 20563, C:Type điền)', () => {
  const products = [cushion(), lamp(), mirror()];
  const groups = groupProductsByTheme(products);
  const { files } = buildGroupedEbayCsvs(products, template, config, groups);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'ebay-20563-cushions.csv');
  const { headers, row } = firstDataRow(files[0].csv);
  assert.equal(cell(headers, row, 'Category'), '20563');
  assert.ok(cell(headers, row, 'C:Type'), 'C:Type của gối vẫn điền');
});

// ---- buildDraftGroupedCsvs: mỗi nhóm 1 file, không trộn, tên có DRAFT ------

test('buildDraftGroupedCsvs: đèn/gương/phòng tắm mỗi nhóm 1 file nháp, tên có DRAFT, không trộn, nhóm gối không có file nháp', () => {
  const products = [cushion(), lamp(), mirror(), toilet()];
  const groups = groupProductsByTheme(products);
  const { drafts, skipped } = buildDraftGroupedCsvs(products, template, config, groups);
  assert.equal(drafts.length, 3);
  const byKey = Object.fromEntries(drafts.map((d) => [d.groupKey, d]));
  assert.ok(byKey.lighting);
  assert.ok(byKey.mirrors);
  assert.ok(byKey.bath);
  for (const d of drafts) {
    assert.ok(d.filename.startsWith('ebay-DRAFT-'), `tên file nháp phải có DRAFT: ${d.filename}`);
    assert.equal(d.isDraft, true);
    assert.equal(d.categoryId, null);
    assert.equal(d.productCount, 1);
    assert.ok(d.missingColumns.includes('Category'));
    assert.equal(d.draftCategorySuggestion, null, 'không có gợi ý AI thì suggestion null');
  }
  assert.ok(!drafts.some((d) => d.groupKey === 'cushions'), 'nhóm gối không có file nháp');
  // Không trộn nhóm: file đèn chỉ chứa đèn, không chứa gối/gương.
  const lampCsv = byKey.lighting.csv;
  assert.ok(lampCsv.includes('Archie Table Lamp'));
  assert.ok(!lampCsv.includes('Daxton Square Cushion'), 'file nháp đèn không lẫn gối');
  assert.ok(!lampCsv.includes('Betty Wall Mirror'), 'file nháp đèn không lẫn gương');
  assert.deepEqual(skipped, [], 'không có nhóm chưa phân loại trong bộ này');
});

test('buildDraftGroupedCsvs: sản phẩm chưa phân loại không có file nháp, ghi vào skipped', () => {
  const products = [cushion(), lamp()];
  const assignments = [
    { productId: products[0].id, groupKey: 'cushions', groupLabel: 'Cushions & Pillows', ebayType: 'Cushion' },
    { productId: products[1].id, groupKey: 'chua-phan-loai', groupLabel: 'Chưa phân loại', ebayType: null },
  ];
  const groups = groupProductsByAiAssignments(products, assignments);
  const { drafts, skipped } = buildDraftGroupedCsvs(products, template, config, groups);
  assert.equal(drafts.length, 0, 'chưa phân loại thì không làm file nháp');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, 'chua-phan-loai');
});

// ---- gợi ý danh mục AI không lọt vào cột Category ---------------------------

test('buildDraftGroupedCsvs + gợi ý AI: suggestion gắn vào file nháp để hiển thị, cột Category trong CSV vẫn trống', () => {
  const products = [lamp()];
  const groups = groupProductsByTheme(products);
  const { drafts } = buildDraftGroupedCsvs(products, template, config, groups);
  assert.equal(drafts.length, 1);
  const withSuggestion = buildDraftGroupedCsvs(products, template, {
    ...config,
    draftCategorySuggestions: [{ groupKey: 'lighting', suggestedCategory: 'Table Lamps', suggestedAspects: ['Bulb Type', 'Wattage'] }],
  }, groups);
  const d = withSuggestion.drafts[0];
  assert.deepEqual(d.draftCategorySuggestion, { suggestedCategory: 'Table Lamps', suggestedAspects: ['Bulb Type', 'Wattage'], unverified: true });
  const { headers, row } = firstDataRow(d.csv);
  assert.equal(cell(headers, row, 'Category'), '', 'gợi ý AI KHÔNG được ghi vào cột Category');
  assert.equal(cell(headers, row, 'C:Type'), '', 'gợi ý AI KHÔNG được ghi vào C:Type');
});

// ---- prompt + kiểm chứng gợi ý danh mục -------------------------------------

test('buildAiDraftCategoryPrompt: gửi key/label/tên mẫu, yêu cầu mảng JSON, nói rõ là phỏng đoán chưa xác minh', () => {
  const { system, user } = buildAiDraftCategoryPrompt([
    { key: 'table-lamps', label: 'Table Lamps', count: 28, sampleTitles: ['Soho Home Archie Table Lamp'] },
  ]);
  assert.match(system, /PHỎNG ĐOÁN|chưa xác minh/i);
  assert.match(system, /suggestedCategory/);
  assert.match(system, /suggestedAspects/);
  assert.match(system, /không bịa CategoryId/);
  const list = JSON.parse(user);
  assert.equal(list.length, 1);
  assert.equal(list[0].groupKey, 'table-lamps');
  assert.ok(list[0].sampleTitles.includes('Soho Home Archie Table Lamp'));
});

test('normalizeDraftCategorySuggestions: đúng -> giữ; nhóm lạ / tên rỗng / trùng -> bỏ + warning', () => {
  const groups = [
    { key: 'table-lamps', label: 'Table Lamps' },
    { key: 'wall-mirrors', label: 'Wall Mirrors' },
  ];
  const raw = [
    { groupKey: 'table-lamps', suggestedCategory: 'Table Lamps', suggestedAspects: ['Bulb Type', '', 'Wattage', 'Bulb Type'], note: 'tra ở Seller Hub' },
    { groupKey: 'nhom-la', suggestedCategory: 'Chairs', suggestedAspects: [] },
    { groupKey: 'wall-mirrors', suggestedCategory: '  ', suggestedAspects: ['Frame Material'] },
    { groupKey: 'table-lamps', suggestedCategory: 'Lamps', suggestedAspects: [] },
  ];
  const { suggestions, warnings } = normalizeDraftCategorySuggestions(raw, groups);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].groupKey, 'table-lamps');
  assert.equal(suggestions[0].suggestedCategory, 'Table Lamps');
  assert.deepEqual(suggestions[0].suggestedAspects, ['Bulb Type', 'Wattage'], 'bỏ chuỗi rỗng + trùng');
  assert.equal(suggestions[0].note, 'tra ở Seller Hub');
  assert.ok(warnings.some((w) => w.includes('nhóm lạ')));
  assert.ok(warnings.some((w) => w.includes('2 lần')));
});

test('normalizeDraftCategorySuggestions: không phải mảng -> lỗi (để caller fallback)', () => {
  assert.throws(() => normalizeDraftCategorySuggestions({ a: 1 }, []), /mảng JSON/);
});

test('suggestDraftCategoriesWithRuntime (Gemini mock): trả gợi ý cho nhóm đèn, bỏ nhóm gối + chưa phân loại', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AQ-test', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  rt.fetchFn = mockFetch((_url, init) => {
    const body = JSON.parse(init.body);
    const list = JSON.parse(body.contents[0].parts[0].text);
    return okJson(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify(list.map((g) => ({
        groupKey: g.groupKey, suggestedCategory: 'Table Lamps',
        suggestedAspects: ['Bulb Type', 'Wattage'], note: 'kiểm chứng ở Seller Hub',
      }))) }] } }],
    });
  });
  const result = await suggestDraftCategoriesWithRuntime([
    { key: 'cushions', label: 'Cushions & Pillows', count: 53, sampleTitles: ['Daxton'] },
    { key: 'table-lamps', label: 'Table Lamps', count: 28, sampleTitles: ['Archie Table Lamp'] },
    { key: 'chua-phan-loai', label: 'Chưa phân loại', count: 1, sampleTitles: ['Dax'] },
  ], rt);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.suggestions.length, 1, 'chỉ gợi ý cho nhóm chưa có template');
  assert.equal(result.suggestions[0].groupKey, 'table-lamps');
  assert.equal(result.suggestions[0].suggestedCategory, 'Table Lamps');
  assert.equal(rt.fetchFn.calls.length, 1, 'chỉ 1 lần gọi cho tất cả nhóm');
});

test('suggestDraftCategoriesWithRuntime: chưa có key -> gợi ý rỗng + warning, không gọi fetch, file nháp vẫn tạo được', async () => {
  const rt = new AiRuntime({ AI_MIN_INTERVAL_MS: '0' });
  let fetchCalls = 0;
  rt.fetchFn = async () => { fetchCalls++; return okJson(200, {}); };
  const result = await suggestDraftCategoriesWithRuntime(
    [{ key: 'table-lamps', label: 'Table Lamps', count: 1, sampleTitles: ['Archie'] }], rt,
  );
  assert.equal(result.provider, 'rule-based');
  assert.deepEqual(result.suggestions, []);
  assert.ok(result.warnings.some((w) => w.includes('Chưa có key AI')));
  assert.equal(fetchCalls, 0);
  const { drafts } = buildDraftGroupedCsvs([lamp()], template, config);
  assert.equal(drafts.length, 1, 'không có key AI vẫn tạo được file nháp');
});

test('suggestDraftCategoriesWithRuntime: LLM lỗi 429 -> gợi ý rỗng + warning chứa 429, không throw', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AQ-test', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  rt.fetchFn = mockFetch(() => okJson(429, { error: { message: 'Quota exceeded' } }));
  const result = await suggestDraftCategoriesWithRuntime(
    [{ key: 'table-lamps', label: 'Table Lamps', count: 1, sampleTitles: ['Archie'] }], rt,
  );
  assert.deepEqual(result.suggestions, []);
  assert.ok(result.warnings.some((w) => w.includes('429')));
});

// ---- endpoint POST /api/ai/draft-categories ----------------------------------

test('POST /api/ai/draft-categories (Gemini mock): trả suggestions, không lộ key', async () => {
  const store = new MemoryStore();
  const rt = new AiRuntime({ AI_API_KEY: 'AQ-test', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  rt.fetchFn = mockFetch((_url, init) => {
    const body = JSON.parse(init.body);
    const list = JSON.parse(body.contents[0].parts[0].text);
    return okJson(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify(list.map((g) => ({
        groupKey: g.groupKey, suggestedCategory: 'Wall Mirrors',
        suggestedAspects: ['Frame Material'], note: null,
      }))) }] } }],
    });
  });
  const { status, json } = await handleRequest(store, {
    method: 'POST', path: '/api/ai/draft-categories',
    body: { groups: [{ key: 'wall-mirrors', label: 'Wall Mirrors', count: 7, sampleTitles: ['Betty'] }] },
  }, { aiRuntime: rt });
  assert.equal(status, 200);
  assert.equal(json.provider, 'gemini');
  assert.equal(json.suggestions.length, 1);
  assert.equal(json.suggestions[0].suggestedCategory, 'Wall Mirrors');
  assert.ok(!JSON.stringify(json).includes('AQ-test'), 'response không lộ key');
});

test('POST /api/ai/draft-categories: không có key -> 200 gợi ý rỗng; body sai -> 400; >50 nhóm -> 400', async () => {
  const store = new MemoryStore();
  const rtNoKey = new AiRuntime({ AI_MIN_INTERVAL_MS: '0' });
  const res1 = await handleRequest(store, {
    method: 'POST', path: '/api/ai/draft-categories',
    body: { groups: [{ key: 'table-lamps', label: 'Table Lamps' }] },
  }, { aiRuntime: rtNoKey });
  assert.equal(res1.status, 200);
  assert.equal(res1.json.provider, 'rule-based');
  assert.deepEqual(res1.json.suggestions, []);

  const res2 = await handleRequest(store, {
    method: 'POST', path: '/api/ai/draft-categories', body: {},
  }, { aiRuntime: rtNoKey });
  assert.equal(res2.status, 400);
  assert.equal(res2.json.error, 'groups_required');

  const many = Array.from({ length: 51 }, (_, i) => ({ key: `g${i}`, label: `G${i}` }));
  const res3 = await handleRequest(store, {
    method: 'POST', path: '/api/ai/draft-categories', body: { groups: many },
  }, { aiRuntime: rtNoKey });
  assert.equal(res3.status, 400);
  assert.equal(res3.json.error, 'too_many_groups');
});

// ---- dữ liệu sheet thật: file nháp cho mọi nhóm chưa có template -------------

test('autoSheetToCsv (sheet thật 117 dòng): file nháp đủ 6 nhóm, đếm đúng số dòng mỗi file', () => {
  const csvText = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const result = autoSheetToCsv(csvText, [], template, config);
  assert.equal(result.files.length, 1, 'chỉ nhóm gối có file upload được');
  assert.equal(result.files[0].filename, 'ebay-20563-cushions.csv');
  assert.equal(result.files[0].productCount, 53);
  const byKey = Object.fromEntries(result.draftFiles.map((d) => [d.groupKey, d]));
  assert.equal(result.draftFiles.length, 6);
  assert.equal(byKey.lighting.productCount, 39);
  assert.equal(byKey.bath.productCount, 8);
  assert.equal(byKey.mirrors.productCount, 7);
  assert.equal(byKey.seating.productCount, 3);
  assert.equal(byKey.beds.productCount, 2);
  assert.equal(byKey.storage.productCount, 1);
  assert.equal(result.stats.draftFiles, 6);
  assert.equal(result.stats.draftProducts, 60);
  assert.equal(result.stats.exportedProducts, 53);
  for (const d of result.draftFiles) {
    assert.ok(d.filename.startsWith('ebay-DRAFT-'), d.filename);
    const { headers, rowCount } = firstDataRow(d.csv);
    assert.equal(headers.length, 98);
    assert.equal(rowCount, d.productCount, `file ${d.filename} đủ số dòng`);
    assert.ok(d.missingColumns.includes('Category'));
    assert.ok(d.missingColumns.includes('C:Type'));
  }
  // File nháp đèn không lẫn gối: kiểm tra tiêu đề trong file.
  const lampCsv = byKey.lighting.csv;
  assert.ok(!lampCsv.includes('Daxton Square Cushion'));
  assert.ok(lampCsv.includes('Archie Table Lamp'));
});

test('autoSheetToCsv (sheet thật, v8.1): cả 6 file nháp không còn "20563", mỗi file đúng 1 dòng DRAFT, số dòng dữ liệu không đổi', () => {
  const csvText = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const result = autoSheetToCsv(csvText, [], template, config);
  assert.equal(result.draftFiles.length, 6);
  const expectedCounts = { lighting: 39, bath: 8, mirrors: 7, seating: 3, beds: 2, storage: 1 };
  for (const d of result.draftFiles) {
    assert.ok(!d.csv.includes('20563'), `file ${d.filename} không được chứa mã 20563 của gối`);
    assert.ok(!d.csv.includes('For categoryId'), `file ${d.filename} không còn dòng Info categoryId của gối`);
    assert.ok(!d.csv.includes('Back Cushion'), `file ${d.filename} không còn giá trị Type của gối`);
    const { rows, headers, rowCount } = firstDataRow(d.csv);
    assert.equal(headers.length, 98);
    assert.equal(rowCount, expectedCounts[d.groupKey], `file ${d.filename} đủ số dòng dữ liệu`);
    assert.equal(rows[2][0], 'DRAFT', `file ${d.filename}: dòng cảnh báo DRAFT ngay dưới header`);
    assert.equal(rows[2][1], DRAFT_WARNING_TEXT);
    assert.equal(rows.filter((r) => r[0] === 'DRAFT').length, 1, `file ${d.filename}: chỉ đúng 1 dòng DRAFT`);
    assert.equal(rows.filter((r) => r[0] === 'Info').length, 1, `file ${d.filename}: chỉ còn dòng Version bắt đầu bằng Info`);
    // Category + toàn bộ C: trong dòng dữ liệu vẫn trống.
    const dataRow = rows[3];
    assert.equal(cell(headers, dataRow, 'Category'), '');
    for (const h of headers) {
      const name = String(h).replace(/^\*/, '');
      if (name.startsWith('C:')) assert.equal(cell(headers, dataRow, name), '', `${d.filename}: cột ${name} để trống`);
    }
  }
  // File gối upload được trong cùng lần chạy vẫn giữ Info đúng của 20563.
  assert.ok(result.files[0].csv.includes('For categoryId:  20563'));
});

test('autoSheetToCsv (sheet thật): gợi ý AI gắn vào file nháp qua config, Category vẫn trống', () => {
  const csvText = readFileSync(path.join(root, 'tests', 'fixtures', 'Sabo_Lucky_Rate_9_Soho_Home.csv'), 'utf-8');
  const result = autoSheetToCsv(csvText, [], template, {
    ...config,
    draftCategorySuggestions: [{ groupKey: 'lighting', suggestedCategory: 'Table Lamps', suggestedAspects: ['Bulb Type'] }],
  });
  const d = result.draftFiles.find((f) => f.groupKey === 'lighting');
  assert.deepEqual(d.draftCategorySuggestion, { suggestedCategory: 'Table Lamps', suggestedAspects: ['Bulb Type'], unverified: true });
  const { headers, row } = firstDataRow(d.csv);
  assert.equal(cell(headers, row, 'Category'), '');
});
