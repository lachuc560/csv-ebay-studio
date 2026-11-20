import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EBAY_TYPES_20563, AI_SPECIFIC_ASPECTS, parseEbayTemplate, normalizeRecord,
  buildEbayTemplateCsv,
} from '../public/core.js';
import {
  AiRuntime, buildAiPrompt, stripHtmlToText, extractJsonObject,
  normalizeLlmSuggestion, callOpenAiCompatible, callGemini, isRateLimitError,
  GEMINI_FREE_TIER_MIN_INTERVAL_MS,
} from '../server/ai-providers.mjs';
import { suggestFromProduct, suggestWithRuntime, validateAiSuggestion } from '../server/ai.mjs';
import { MemoryStore, handleRequest, createApiKey } from '../server/api.mjs';

// Template eBay thật (nhúng sẵn trong repo) — nguồn chuẩn để đối chiếu.
const template = parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf-8'));

// Gối Soho Home thật: tên chứa từ khoá "Cushion", có specs + GIÁ BÁN sheet.
function makeCushion() {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
    source_product_id: 'daxton-square-cushion',
    brand: 'Soho Home',
    title: 'Soho Home Daxton Square Cushion',
    description_text: '<p>Square cushion woven in Italy from a viscose, cotton and polyester jacquard with an abstract hand-painted pattern and rose-toned pom-pom trim, with a feather and down inner pad included.</p>',
    images: ['https://assets.sohohome.com/images/original/219835-79996850-listingjpg.jpg'],
    specs: { Dimensions: 'H50 x W50 x D12cm / H20 x W20 x D5"', Material: '42% Viscose, 40% Cotton, 18% Polyester' },
    variants: [{ options: { Size: '50 x 50cm' }, price: 395, in_stock: true }],
  });
  product.edits = { price: 280 }; // GIÁ BÁN đã chốt trong sheet
  return product;
}

// Sản phẩm tên không chứa từ khoá loại (vd "Soho Home Dax", "Mayfair").
function makeNoKeywordProduct() {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: 'https://www.sohohome.com/us/products/dax',
    source_product_id: 'dax',
    brand: 'Soho Home',
    title: 'Soho Home Dax',
    description_text: 'A decorative cushion with jacquard fabric.',
    images: ['https://assets.sohohome.com/x.jpg'],
    variants: [{ options: {}, price: 350, in_stock: true }],
  });
  return product;
}

const okJson = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const llmCushionJson = JSON.stringify({
  title: 'Soho Home Daxton Square Cushion Italian Jacquard Feather Inner Pad Rose Pom-Pom Trim Extra Long Title To Test Truncation',
  ebayType: 'Throw Pillow',
  specifics: { Material: 'Viscose jacquard', Color: 'Rose', Size: '50 x 50cm', Brand: 'Fake Brand', Foo: 'bar' },
});

// ---- danh sách cho phép (đối chiếu template thật) ---------------------------

test('EBAY_TYPES_20563: 22 giá trị, khớp 100% template 20563 thật', () => {
  assert.equal(EBAY_TYPES_20563.length, 22);
  assert.deepEqual([...EBAY_TYPES_20563].sort(), [...template.recommendedValues.Type].sort());
});

test('AI_SPECIFIC_ASPECTS: mọi khía cạnh đều là cột C: có trong template', () => {
  const cCols = template.headers.filter((h) => h.includes('C:')).map((h) => h.replace(/^\*/, '').replace(/^C:/, ''));
  for (const aspect of AI_SPECIFIC_ASPECTS) {
    assert.ok(cCols.includes(aspect), `aspect ${aspect} không có trong template`);
  }
  assert.ok(!AI_SPECIFIC_ASPECTS.includes('Brand'), 'Brand không được để LLM điền');
  assert.ok(!AI_SPECIFIC_ASPECTS.includes('Type'), 'Type đi riêng theo ebayType');
});

// ---- prompt -----------------------------------------------------------------

test('stripHtmlToText: bỏ tag/script, giải entity, cắt ~2000 ký tự', () => {
  assert.equal(stripHtmlToText('<p>Hello <b>world</b></p><script>alert(1)</script>'), 'Hello world');
  assert.equal(stripHtmlToText('A&nbsp;B &amp; C'), 'A B & C');
  assert.equal(stripHtmlToText('x'.repeat(3000)).length, 2000);
  assert.equal(stripHtmlToText(null), '');
});

test('buildAiPrompt: đủ dữ liệu sản phẩm + sheet, text thuần, liệt kê 22 Type', () => {
  const { system, user } = buildAiPrompt(makeCushion());
  assert.match(system, /22 giá trị/);
  assert.ok(system.includes('Throw Pillow'));
  assert.ok(system.includes('Cushion'));
  assert.match(user, /Daxton Square Cushion/);
  assert.match(user, /GIÁ BÁN đã chốt trong sheet: 280/);
  assert.match(user, /42% Viscose/);
  assert.ok(!user.includes('<p>'), 'mô tả gửi LLM phải là text thuần, không còn HTML');
  assert.ok(!user.includes('alert('));
});

test('extractJsonObject: JSON trần, fence ```json, text thừa; JSON hỏng thì throw', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Đây là gợi ý:\n{"a":1}\nHết.'), { a: 1 });
  assert.throws(() => extractJsonObject('không có json'), /không trả JSON hợp lệ/);
  assert.throws(() => extractJsonObject('{a:1'), /không trả JSON hợp lệ|Unexpected/);
});

// ---- kiểm chứng gợi ý LLM ----------------------------------------------------

test('normalizeLlmSuggestion: title cắt 80, Type giữ, specifics lọc, Brand lấy từ sản phẩm', () => {
  const raw = JSON.parse(llmCushionJson);
  const { suggestion, warnings } = normalizeLlmSuggestion(raw, makeCushion());
  assert.ok(suggestion.title.length <= 80);
  assert.equal(suggestion.ebayType, 'Throw Pillow');
  assert.equal(suggestion.specifics.Material, 'Viscose jacquard');
  assert.equal(suggestion.specifics.Color, 'Rose');
  assert.equal(suggestion.specifics.Brand, 'Soho Home', 'Brand lấy từ sản phẩm, không lấy Brand do LLM bịa');
  assert.equal(suggestion.specifics.Foo, undefined, 'khía cạnh không có trong template thì bỏ');
  assert.deepEqual(warnings, []);
});

test('normalizeLlmSuggestion: Type ngoài danh sách -> null + warning, KHÔNG tự đoán', () => {
  const { suggestion, warnings } = normalizeLlmSuggestion(
    { title: 'Soho Home Dax', ebayType: 'Velvet Pillow', specifics: {} },
    makeNoKeywordProduct(),
  );
  assert.equal(suggestion.ebayType, null);
  assert.ok(warnings.some((w) => w.includes('ngoài danh sách cho phép')));
});

test('normalizeLlmSuggestion: Type viết thường vẫn chuẩn hoá về dạng chuẩn', () => {
  const { suggestion, warnings } = normalizeLlmSuggestion(
    { title: 'Soho Home Dax', ebayType: 'throw pillow', specifics: {} },
    makeNoKeywordProduct(),
  );
  assert.equal(suggestion.ebayType, 'Throw Pillow');
  assert.ok(!warnings.some((w) => w.includes('ngoài danh sách')));
});

test('normalizeLlmSuggestion: không có Type thì warning, không bịa', () => {
  const { suggestion, warnings } = normalizeLlmSuggestion({ title: 'Soho Home Dax', specifics: {} }, makeNoKeywordProduct());
  assert.equal(suggestion.ebayType, null);
  assert.ok(warnings.some((w) => w.includes('không gợi ý được Type')));
});

// ---- provider OpenAI ----------------------------------------------------------

test('callOpenAiCompatible: gửi đúng model/messages/response_format + Bearer key, parse JSON', async () => {
  const fetchFn = mockFetch(() => okJson(200, { choices: [{ message: { content: llmCushionJson } }] }));
  const out = await callOpenAiCompatible({
    baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini',
    apiKey: 'sk-test', system: 'sys', user: 'usr', fetchFn,
  });
  assert.equal(out.ebayType, 'Throw Pillow');
  assert.equal(fetchFn.calls.length, 1);
  const call = fetchFn.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
});

test('callOpenAiCompatible: API tương thích không hỗ trợ response_format (400) -> thử lại không có nó', async () => {
  const fetchFn = mockFetch((_url, _init, n) => (n === 1
    ? okJson(400, { error: { message: 'response_format unsupported' } })
    : okJson(200, { choices: [{ message: { content: '{"ebayType":"Cushion"}' } }] })));
  const out = await callOpenAiCompatible({
    baseUrl: 'https://compat.example/v1/chat/completions', model: 'm', apiKey: 'k',
    system: 's', user: 'u', fetchFn,
  });
  assert.equal(out.ebayType, 'Cushion');
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(JSON.parse(fetchFn.calls[1].init.body).response_format, undefined);
});

test('callOpenAiCompatible: content không phải JSON -> throw', async () => {
  const fetchFn = mockFetch(() => okJson(200, { choices: [{ message: { content: 'xin chào' } }] }));
  await assert.rejects(
    () => callOpenAiCompatible({ baseUrl: 'https://x', model: 'm', apiKey: 'k', system: 's', user: 'u', fetchFn }),
    /không trả JSON hợp lệ/,
  );
});

test('callOpenAiCompatible: timeout -> throw lỗi timeout (không treo)', async () => {
  const hanging = () => new Promise(() => {});
  await assert.rejects(
    () => callOpenAiCompatible({ baseUrl: 'https://x', model: 'm', apiKey: 'k', system: 's', user: 'u', fetchFn: hanging, timeoutMs: 50 }),
    /timeout sau/,
  );
});

// ---- provider Gemini ----------------------------------------------------------

test('callGemini: key qua header, system_instruction + responseMimeType JSON, parse candidates', async () => {
  const fetchFn = mockFetch(() => okJson(200, {
    candidates: [{ content: { parts: [{ text: '```json\n' + llmCushionJson + '\n```' }] } }],
  }));
  const out = await callGemini({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash',
    apiKey: 'AIza-fake-key', system: 'sys', user: 'usr', fetchFn,
  });
  assert.equal(out.ebayType, 'Throw Pillow');
  const call = fetchFn.calls[0];
  assert.match(call.url, /models\/gemini-2\.0-flash:generateContent$/);
  assert.equal(call.init.headers['x-goog-api-key'], 'AIza-fake-key');
  assert.ok(!call.url.includes('AIza-fake-key'));
  const body = JSON.parse(call.init.body);
  assert.equal(body.system_instruction.parts[0].text, 'sys');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, undefined, 'sampling parameters are not compatible with all current Gemini models');
});

test('callGemini: HTTP 401 -> throw rõ mã lỗi', async () => {
  const fetchFn = mockFetch(() => okJson(401, { error: { message: 'API key not valid' } }));
  await assert.rejects(
    () => callGemini({ baseUrl: 'https://x', model: 'gemini-2.0-flash', apiKey: 'bad', system: 's', user: 'u', fetchFn }),
    /Gemini lỗi HTTP 401/,
  );
});

test('callGemini: 404 discovers supported text models instead of guessing a retired fallback', async () => {
  const fetchFn = mockFetch((url, init, n) => {
    assert.equal(init.headers['x-goog-api-key'], 'AQ-fake-key');
    assert.ok(!url.includes('AQ-fake-key'));
    if (n === 1) return okJson(404, { error: { message: 'not found' } });
    if (init.method === 'GET') return okJson(200, { models: [
      { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ] });
    return okJson(200, { candidates: [{ content: { parts: [{ text: '{"ebayType":"Cushion"}' }] } }] });
  });
  const out = await callGemini({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash',
    apiKey: 'AQ-fake-key', system: 's', user: 'u', fetchFn,
  });
  assert.equal(out.ebayType, 'Cushion');
  assert.equal(fetchFn.calls.length, 3);
  assert.match(fetchFn.calls[0].url, /models\/gemini-2\.5-flash:generateContent/);
  assert.match(fetchFn.calls[1].url, /models\?pageSize=1000$/);
  assert.match(fetchFn.calls[2].url, /models\/gemini-3\.5-flash-lite:generateContent/);
});

test('callGemini: unavailable discovered models stop after two recovery attempts', async () => {
  const fetchFn = mockFetch((_url, init) => init.method === 'GET'
    ? okJson(200, { models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'].map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) })
    : okJson(404, { error: { message: 'not found' } }));
  await assert.rejects(
    () => callGemini({ baseUrl: 'https://x', model: 'gemini-2.5-flash', apiKey: 'AQ-fake', system: 's', user: 'u', fetchFn }),
    /Gemini lỗi HTTP 404.*ListModels.*đã cấu hình key/,
  );
  assert.equal(fetchFn.calls.length, 4);
  assert.ok(fetchFn.calls.every((call) => !call.url.includes('gemini-2.0-flash')));
});

test('callGemini: paginated discovery skips unsuitable models and accepts models/ prefix', async () => {
  const fetchFn = mockFetch((url, init) => {
    if (init.method === 'POST' && url.includes('old-flash')) return okJson(404, {});
    if (init.method === 'GET' && !url.includes('pageToken=')) return okJson(200, {
      models: [{ name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next/page',
    });
    if (init.method === 'GET') {
      assert.ok(url.includes('pageToken=next%2Fpage'));
      return okJson(200, { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] });
    }
    return okJson(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  });
  assert.deepEqual(await callGemini({ model: 'models/old-flash', apiKey: 'fake', system: 's', user: 'u', fetchFn }), { ok: true });
  assert.equal(fetchFn.calls.length, 4);
  assert.ok(fetchFn.calls.every((call) => !call.url.includes('models%2F')));
});

test('callGemini: no supported Flash candidate reports an actionable 404 without a Pro upgrade', async () => {
  const fetchFn = mockFetch((_url, init) => init.method === 'POST' ? okJson(404, {}) : okJson(200, {
    models: [{ name: 'models/gemini-4-pro', supportedGenerationMethods: ['generateContent'] }],
  }));
  await assert.rejects(callGemini({ model: 'old-flash', apiKey: 'fake', system: 's', user: 'u', fetchFn }), /HTTP 404.*quyền truy cập/);
  assert.equal(fetchFn.calls.length, 2);
});

test('callGemini: recovery stops immediately on quota or permission failure', async () => {
  for (const status of [403, 429]) {
    const fetchFn = mockFetch((_url, init, n) => {
      if (n === 1) return okJson(404, {});
      if (init.method === 'GET') return okJson(200, { models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'].map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) });
      return okJson(status, {});
    });
    await assert.rejects(callGemini({ model: 'old-flash', apiKey: 'fake', system: 's', user: 'u', fetchFn }), new RegExp(`HTTP ${status}`));
    assert.equal(fetchFn.calls.length, 3, 'do not try another model after quota/permission failure');
  }
});

test('callGemini: ListModels failure and timeout remain bounded', async () => {
  const denied = mockFetch((_url, init) => okJson(init.method === 'GET' ? 403 : 404, {}));
  await assert.rejects(callGemini({ model: 'old-flash', apiKey: 'fake', system: 's', user: 'u', fetchFn: denied }), /ListModels lỗi HTTP 403/);
  assert.equal(denied.calls.length, 2);
  const hanging = mockFetch((_url, init) => init.method === 'POST' ? okJson(404, {}) : new Promise(() => {}));
  await assert.rejects(callGemini({ model: 'old-flash', apiKey: 'fake', system: 's', user: 'u', fetchFn: hanging, timeoutMs: 30 }), /timeout/);
  assert.equal(hanging.calls.length, 2);
});

test('AiRuntime: caches recovered model by credentials/configuration and reports actual model without key', async () => {
  const rt = new AiRuntime({ AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' });
  rt.setMemoryConfig({ model: 'old-flash', apiKey: 'first-fake-key' });
  rt.fetchFn = mockFetch((url, init) => {
    if (init.method === 'GET') return okJson(200, { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] });
    if (url.includes('/old-flash:')) return okJson(404, {});
    return okJson(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  });
  assert.deepEqual(await rt.callLlmJson('s', 'u'), { ok: true });
  assert.equal(rt.fetchFn.calls.length, 3);
  assert.equal(rt.getStatus().model, 'gemini-3.5-flash-lite');
  assert.equal(rt.getStatus().configuredModel, 'old-flash');
  assert.ok(!JSON.stringify(rt.getStatus()).includes('fake-key'));
  await rt.callLlmJson('s', 'u');
  assert.equal(rt.fetchFn.calls.length, 4, 'next request directly uses successful model');
  rt.setMemoryConfig({ apiKey: 'second-fake-key' });
  assert.equal(rt.getStatus().model, 'old-flash', 'new key invalidates old selection');
  await rt.callLlmJson('s', 'u');
  assert.equal(rt.fetchFn.calls.length, 7);
});

test('AiRuntime: key AI Studio mới bắt đầu bằng "AQ." được chấp nhận như key cũ "AIza" (không kiểm tra tiền tố)', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AQ.test-key-dang-moi', AI_PROVIDER: 'gemini' });
  assert.equal(rt.getStatus().configured, true);
  assert.equal(rt.getStatus().model, 'gemini-2.5-flash');
  rt.fetchFn = mockFetch(() => okJson(200, {
    candidates: [{ content: { parts: [{ text: '{"ebayType":"Throw Pillow"}' }] } }],
  }));
  const result = await suggestWithRuntime(makeCushion(), rt);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.suggestion.ebayType, 'Throw Pillow');
  assert.equal(rt.fetchFn.calls[0].init.headers['x-goog-api-key'], 'AQ.test-key-dang-moi');

  const rt2 = new AiRuntime({});
  rt2.setMemoryConfig({ provider: 'gemini', apiKey: 'AQ.web-key-dang-moi' });
  assert.deepEqual(rt2.getStatus(), { configured: true, provider: 'gemini', model: 'gemini-2.5-flash', source: 'web' });
});

// ---- quota và giãn cách Gemini -------------------------------------------

test('callGemini: HTTP 429 -> lỗi rõ, đề nghị kiểm tra quota model/project nếu kéo dài', async () => {
  const fetchFn = mockFetch(() => okJson(429, { error: { message: 'Quota exceeded' } }));
  await assert.rejects(
    () => callGemini({ baseUrl: 'https://x', model: 'gemini-2.0-flash', apiKey: 'AIza-fake', system: 's', user: 'u', fetchFn }),
    /chạm giới hạn request \(HTTP 429\).*đợi 1 phút.*quota.*model\/project/,
  );
});

test('callOpenAiCompatible: HTTP 429 -> lỗi rõ giới hạn request/phút', async () => {
  const fetchFn = mockFetch(() => okJson(429, { error: { message: 'Rate limit' } }));
  await assert.rejects(
    () => callOpenAiCompatible({ baseUrl: 'https://x', model: 'gpt-4o-mini', apiKey: 'sk-x', system: 's', user: 'u', fetchFn }),
    /chạm giới hạn request \(HTTP 429\)/,
  );
});

test('isRateLimitError: nhận biết lỗi 429, không nhận nhầm lỗi khác', () => {
  assert.equal(isRateLimitError(new Error('AI chạm giới hạn request (HTTP 429) — đợi 1 phút')), true);
  assert.equal(isRateLimitError(new Error('fetch failed')), false);
  assert.equal(isRateLimitError(new Error('Gemini lỗi HTTP 500')), false);
});

test('AiRuntime: Gemini mặc định giãn 4 giây/lần gọi; OpenAI không giãn; env AI_MIN_INTERVAL_MS ghi đè được', () => {
  assert.equal(GEMINI_FREE_TIER_MIN_INTERVAL_MS, 4000);
  assert.equal(new AiRuntime({ AI_API_KEY: 'k', AI_PROVIDER: 'gemini' }).getMinIntervalMs(), 4000);
  assert.equal(new AiRuntime({ AI_API_KEY: 'k', AI_PROVIDER: 'openai' }).getMinIntervalMs(), 0);
  assert.equal(new AiRuntime({ AI_API_KEY: 'k', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '100' }).getMinIntervalMs(), 100);
  assert.equal(new AiRuntime({ AI_API_KEY: 'k', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '0' }).getMinIntervalMs(), 0);
  assert.equal(new AiRuntime({ AI_PROVIDER: 'gemini' }).getStatus().model, 'gemini-2.5-flash');
});

test('AiRuntime: 2 lần gọi Gemini liên tiếp cách nhau ít nhất giãn cách tối thiểu', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AIza-fake', AI_PROVIDER: 'gemini', AI_MIN_INTERVAL_MS: '100' });
  rt.fetchFn = mockFetch(() => okJson(200, {
    candidates: [{ content: { parts: [{ text: '{"ebayType":"Cushion"}' }] } }],
  }));
  const fn = rt.getProviderFn();
  const t0 = Date.now();
  await fn(makeCushion());
  await fn(makeCushion());
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100, `2 lần gọi phải cách nhau >= 100ms, thực tế ${elapsed}ms`);
});

test('suggestWithRuntime: Gemini 429 -> fallback rule-based, warning chứa 429 để client biết mà DỪNG bulk', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AIza-fake', AI_PROVIDER: 'gemini' });
  rt.fetchFn = mockFetch(() => okJson(429, { error: { message: 'Quota exceeded' } }));
  const result = await suggestWithRuntime(makeCushion(), rt);
  assert.equal(result.provider, 'rule-based');
  assert.ok(result.warnings.some((w) => w.includes('429')), 'warning phải chứa 429 để giao diện nhận biết và dừng gợi ý hàng loạt');
  assert.ok(result.warnings.some((w) => w.includes('đợi 1 phút')));
});

// ---- runtime: key env trước, RAM sau; key không lộ ------------------------------

test('AiRuntime: chưa có key -> chưa cấu hình, provider rule-based (getProviderFn null)', () => {
  const rt = new AiRuntime({});
  assert.deepEqual(rt.getStatus(), { configured: false, provider: 'openai', model: 'gpt-4o-mini', source: 'none' });
  assert.equal(rt.getProviderFn(), null);
});

test('AiRuntime: key env được ưu tiên hơn key dán trong web (source env)', () => {
  const rt = new AiRuntime({ AI_API_KEY: 'sk-env-key', AI_PROVIDER: 'openai' });
  rt.setMemoryConfig({ apiKey: 'sk-web-key', provider: 'gemini', model: 'gemini-2.0-flash' });
  const status = rt.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env');
  // Provider/model lấy theo key dán trong web, nhưng key dùng là key env.
  assert.equal(status.provider, 'gemini');
  const cfg = rt.getEffectiveConfig();
  assert.equal(cfg.apiKey, 'sk-env-key');
  assert.ok(!JSON.stringify(status).includes('sk-env-key'), 'status không được chứa key');
  assert.ok(!JSON.stringify(status).includes('sk-web-key'), 'status không được chứa key web');
});

test('AiRuntime: không có env thì dùng key dán trong web (source web), xoá được', () => {
  const rt = new AiRuntime({});
  rt.setMemoryConfig({ provider: 'gemini', apiKey: 'AIza-web-key' });
  assert.deepEqual(rt.getStatus(), { configured: true, provider: 'gemini', model: 'gemini-2.5-flash', source: 'web' });
  rt.clearMemoryConfig();
  assert.equal(rt.getStatus().configured, false);
  assert.equal(rt.getProviderFn(), null);
});

test('AiRuntime: setMemoryConfig sai provider -> lỗi invalid_provider; applyEnv đổi model', () => {
  const rt = new AiRuntime({});
  assert.throws(() => rt.setMemoryConfig({ provider: 'anthropic' }), (e) => e.code === 'invalid_provider');
  rt.applyEnv({ AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-1.5-pro' });
  assert.equal(rt.getStatus().model, 'gemini-1.5-pro');
});

// ---- suggestWithRuntime: LLM thật (mock) + fallback ---------------------------

test('suggestWithRuntime (OpenAI mock): gợi ý LLM đã kiểm chứng, provider openai', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'sk-test', AI_PROVIDER: 'openai', AI_MODEL: 'gpt-4o-mini' });
  rt.fetchFn = mockFetch(() => okJson(200, { choices: [{ message: { content: llmCushionJson } }] }));
  const result = await suggestWithRuntime(makeCushion(), rt);
  assert.equal(result.provider, 'openai');
  assert.equal(result.suggestion.ebayType, 'Throw Pillow');
  assert.ok(result.suggestion.title.length <= 80);
  assert.equal(result.suggestion.specifics.Brand, 'Soho Home');
  assert.deepEqual(result.warnings, []);
  const check = validateAiSuggestion({ ...result.suggestion, category: result.suggestion.category ?? 'Cushions & Pillows' });
  assert.equal(check.ok, true);
});

test('suggestWithRuntime (Gemini mock): Type ngoài danh sách -> null + warning, vẫn provider gemini', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'AIza-fake', AI_PROVIDER: 'gemini' });
  rt.fetchFn = mockFetch(() => okJson(200, {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Soho Home Dax', ebayType: 'Velvet Pillow', specifics: {} }) }] } }],
  }));
  const result = await suggestWithRuntime(makeNoKeywordProduct(), rt);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.suggestion.ebayType, null);
  assert.ok(result.warnings.some((w) => w.includes('ngoài danh sách cho phép')));
});

test('suggestWithRuntime: LLM lỗi mạng -> fallback rule-based kèm warning, không crash', async () => {
  const rt = new AiRuntime({ AI_API_KEY: 'sk-test' });
  rt.fetchFn = async () => { throw new Error('fetch failed'); };
  const result = await suggestWithRuntime(makeCushion(), rt);
  assert.equal(result.provider, 'rule-based');
  assert.equal(result.suggestion.title, 'Soho Home Daxton Square Cushion');
  assert.ok(result.warnings.some((w) => w.includes('AI lỗi') && w.includes('dùng gợi ý theo luật')));
});

test('suggestFromProduct: provider throw timeout -> fallback rule-based', async () => {
  const result = await suggestFromProduct(makeCushion(), async () => { throw new Error('AI timeout sau 20s'); }, { providerName: 'openai' });
  assert.equal(result.provider, 'rule-based');
  assert.ok(result.warnings.some((w) => w.includes('AI timeout sau 20s')));
});

test('suggestWithRuntime: không có key -> rule-based, provider rule-based', async () => {
  const result = await suggestWithRuntime(makeCushion(), new AiRuntime({}));
  assert.equal(result.provider, 'rule-based');
  assert.equal(result.suggestion.title, 'Soho Home Daxton Square Cushion');
});

// ---- route /api/ai/* ------------------------------------------------------------

async function setupWithProduct() {
  const store = new MemoryStore();
  const { key } = await createApiKey(store, 'test');
  const ingested = await handleRequest(store, {
    method: 'POST', path: '/api/ingest/records', headers: { Authorization: `Bearer ${key}` },
    body: { records: [{
      source_site: 'sohohome.com',
      source_url: 'https://www.sohohome.com/us/products/daxton-square-cushion/79996850',
      source_product_id: 'daxton-square-cushion',
      brand: 'Soho Home',
      title: 'Soho Home Daxton Square Cushion',
      description_text: 'Square cushion woven in Italy.',
      images: ['https://assets.sohohome.com/x.jpg'],
      variants: [{ options: { Size: '50 x 50cm' }, price: 395, in_stock: true }],
    }] },
  });
  return { store, productId: ingested.json.products[0].id };
}

test('route /api/ai/status + /api/ai/config: cấu hình Gemini, key không lộ, xoá được', async () => {
  const rt = new AiRuntime({});
  const opts = { aiRuntime: rt };
  const store = new MemoryStore();

  const before = await handleRequest(store, { method: 'GET', path: '/api/ai/status', headers: {} }, opts);
  assert.equal(before.json.configured, false);

  const bad = await handleRequest(store, {
    method: 'POST', path: '/api/ai/config', headers: {},
    body: { provider: 'anthropic', apiKey: 'x' },
  }, opts);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_provider');

  const saved = await handleRequest(store, {
    method: 'POST', path: '/api/ai/config', headers: {},
    body: { provider: 'gemini', apiKey: 'AIza-fake-secret-key' },
  }, opts);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.configured, true);
  assert.equal(saved.json.provider, 'gemini');
  assert.ok(!JSON.stringify(saved.json).includes('AIza-fake-secret-key'), 'response config không được chứa key');

  const status = await handleRequest(store, { method: 'GET', path: '/api/ai/status', headers: {} }, opts);
  assert.deepEqual(status.json, { ok: true, configured: true, provider: 'gemini', model: 'gemini-2.5-flash', source: 'web' });
  assert.ok(!JSON.stringify(status.json).includes('AIza-fake-secret-key'), 'status không được chứa key');

  const cleared = await handleRequest(store, { method: 'DELETE', path: '/api/ai/config', headers: {} }, opts);
  assert.equal(cleared.json.configured, false);
});

test('route /api/ai/suggest với runtime Gemini mock: provider gemini, key không lộ trong response', async () => {
  const { store, productId } = await setupWithProduct();
  const rt = new AiRuntime({ AI_API_KEY: 'AIza-fake-secret-key', AI_PROVIDER: 'gemini' });
  rt.fetchFn = mockFetch(() => okJson(200, {
    candidates: [{ content: { parts: [{ text: llmCushionJson }] } }],
  }));
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ai/suggest', headers: {}, body: { productId },
  }, { aiRuntime: rt });
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'gemini');
  assert.equal(res.json.suggestion.ebayType, 'Throw Pillow');
  assert.ok(!JSON.stringify(res.json).includes('AIza-fake-secret-key'), 'response suggest không được chứa key');
});

test('route /api/ai/suggest không key: provider rule-based, gợi ý theo luật như cũ', async () => {
  const { store, productId } = await setupWithProduct();
  const res = await handleRequest(store, {
    method: 'POST', path: '/api/ai/suggest', headers: {}, body: { productId },
  }, { aiRuntime: new AiRuntime({}) });
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'rule-based');
  assert.equal(res.json.suggestion.title, 'Soho Home Daxton Square Cushion');
  assert.equal(res.json.suggestion.category, 'Cushions & Pillows');
});

// ---- áp dụng gợi ý vào CSV template --------------------------------------------

test('mapEbayType ưu tiên edits.ebayType đã duyệt; aspectFromProduct ưu tiên edits.aiSpecifics', () => {
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_url: 'https://www.sohohome.com/us/products/dax',
    source_product_id: 'dax',
    brand: 'Soho Home',
    title: 'Soho Home Dax',
    description_text: 'A decorative cushion.',
    images: ['https://assets.sohohome.com/x.jpg'],
    variants: [{ options: {}, price: 350, in_stock: true }],
  });
  // Không có từ khoá loại trong tên: rule-based sẽ để Type trống.
  product.edits = { ebayType: 'Lumbar Pillow', aiSpecifics: { Material: 'Velvet' }, price: 280 };
  const csv = buildEbayTemplateCsv([product], template, {});
  const rows = csv.split('\n');
  const dataRow = rows.find((r) => r.startsWith('Add,'));
  assert.ok(dataRow, 'phải có dòng sản phẩm');
  const cols = dataRow.split(',');
  const typeIdx = template.headers.findIndex((h) => h === '*C:Type');
  const materialIdx = template.headers.findIndex((h) => h === 'C:Material');
  assert.equal(cols[typeIdx], 'Lumbar Pillow');
  assert.equal(cols[materialIdx], 'Velvet');
});
