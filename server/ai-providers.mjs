// server/ai-providers.mjs — Gọi LLM thật phía SERVER cho gợi ý listing eBay.
// Key AI KHÔNG BAO GIỜ rời server: không có trong extension, không lưu
// localStorage, không trả ra ngoài qua API, không ghi log. Key lấy theo
// thứ tự: biến môi trường AI_API_KEY (.env dev / wrangler secret khi deploy)
// trước, rồi cấu hình dán trong web (POST /api/ai/config, chỉ lưu trong RAM,
// mất khi restart). Không có key thì tự fallback về gợi ý theo luật.
//
// Chạy được cả Node (dev-server) và Cloudflare Workers: fetch được truyền
// vào qua runtime.fetchFn (mặc định globalThis.fetch), env được đưa vào
// qua applyEnvToRuntime() — không đọc process.env trực tiếp trong module
// này để Workers vẫn dùng được.

import { EBAY_TYPES_20563, AI_SPECIFIC_ASPECTS, MAX_TITLE_LENGTH, truncateTitle, suggestCategory } from '../public/core.js';

export const AI_PROVIDERS = ['openai', 'gemini'];
export const DEFAULT_AI_MODELS = { openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash' };
// Recovery uses the account's ListModels response, not a hardcoded retired model.
export const GEMINI_MODEL_DISCOVERY_MAX_PAGES = 3;
export const GEMINI_MODEL_RECOVERY_ATTEMPTS = 2;
export const DEFAULT_AI_BASE_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
export const AI_TIMEOUT_MS = 20_000;
export const AI_MAX_DESCRIPTION_CHARS = 2000;
export const AI_MAX_TOKENS = 800;

/**
 * Gemini được giãn mặc định 4 giây giữa các lần gọi tuần tự. Đây là
 * nhịp gọi của tool, không phải cam kết quota: giới hạn thực tế phụ
 * thuộc model và project. Tên hằng giữ để tương thích mã hiện có.
 * Đổi nhịp qua AI_MIN_INTERVAL_MS (mili giây, 0 = không giãn).
 */
export const GEMINI_FREE_TIER_RPM = 15;
export const GEMINI_FREE_TIER_MIN_INTERVAL_MS = Math.ceil(60_000 / GEMINI_FREE_TIER_RPM);
export const OPENAI_MIN_INTERVAL_MS = 0;

// ---- text thuần từ mô tả HTML ----------------------------------------------

/** Bỏ khối <tag>...</tag> bằng indexOf (thời gian tuyến tính). Regex lười
 *  /<script[\s\S]*?<\/script>/ quét tới cuối chuỗi cho MỖI lần mở thẻ không
 *  đóng -> O(n²), chuỗi nhiều "<script" có thể chặn event loop rất lâu.
 *  Thẻ mở không có thẻ đóng thì giữ nguyên phần còn lại (như regex cũ). */
function stripHtmlBlocks(s, tag) {
  const lower = s.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const start = lower.indexOf(open, i);
    if (start === -1) { out += s.slice(i); break; }
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) { out += s.slice(i); break; }
    out += `${s.slice(i, start)} `;
    const gt = lower.indexOf('>', end);
    i = gt === -1 ? s.length : gt + 1;
  }
  return out;
}

/** Bỏ HTML khỏi mô tả, giữ text thuần, tối đa ~2000 ký tự để gửi LLM. */
export function stripHtmlToText(html, maxChars = AI_MAX_DESCRIPTION_CHARS) {
  // Cắt bớt TRƯỚC khi chạy regex: mô tả lưu trong kho có thể tới vài MB,
  // chỉ cần đủ HTML để còn ~maxChars ký tự text sau khi bỏ thẻ.
  const limit = Math.max(1, Number(maxChars) || AI_MAX_DESCRIPTION_CHARS) * 20;
  const raw = String(html ?? '').slice(0, limit);
  const text = stripHtmlBlocks(stripHtmlBlocks(raw, 'script'), 'style')
    // [^<>]* (không chỉ [^>]+) để chuỗi nhiều '<' không bị quét lại O(n²).
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

// ---- prompt ----------------------------------------------------------------

/**
 * Prompt gửi LLM: tên, mô tả text thuần (≤2000 ký tự), specs/dimensions/
 * material, biến thể, và TYPE/NGÁCH/TITLE/COST/GIÁ BÁN từ sheet nếu có.
 * Yêu cầu trả JSON duy nhất: {title, ebayType, specifics: {...}}.
 * LLM KHÔNG được quyết giá bán, Brand, Location/Dispatch/Returns/Profile.
 */
export function buildAiPrompt(product) {
  const p = product ?? {};
  const edits = p.edits ?? {};
  const sheet = {
    type: p.theme ?? p.product_type ?? null,
    brand: p.brand ?? null,
    title: p.title ?? p.title_raw ?? null,
    cost: p.price ?? null,
    gia_ban: edits.price ?? null,
  };
  const variants = (p.variants ?? []).slice(0, 10).map((v) => ({
    options: v.options ?? {},
    price: v.price ?? null,
    in_stock: Boolean(v.in_stock),
  }));
  const system = [
    'Bạn là trợ lý soạn listing eBay US cho mặt hàng gia dụng/nội thất.',
    'Chỉ trả về MỘT object JSON duy nhất, không giải thích, không markdown ngoài JSON:',
    '{"title": "...", "ebayType": "..." hoặc null, "specifics": {"Material": "...", "Color": "...", ...}}',
    `ebayType PHẢI là đúng 1 trong 22 giá trị sau (hoặc null khi không chắc, tuyệt đối không bịa giá trị khác): ${EBAY_TYPES_20563.join('; ')}.`,
    `specifics CHỈ dùng các khía cạnh sau, giá trị ngắn, không bịa thông tin không có trong dữ liệu: ${AI_SPECIFIC_ASPECTS.join('; ')}.`,
    'title: tiếng Anh, giữ tên thương hiệu + tên sản phẩm + đặc điểm chính, tối đa 80 ký tự.',
    'KHÔNG điền giá bán, KHÔNG tự bịa Brand, KHÔNG điền Location/Dispatch/Returns/Profile.',
    'Chỉ suy ra từ dữ liệu dưới đây; thông tin nào không có thì bỏ trống khía cạnh đó.',
  ].join('\n');
  const user = [
    `Tên sản phẩm: ${sheet.title ?? '(không có)'}`,
    `Thương hiệu (từ sheet/trang, đã chốt — không tự bịa): ${sheet.brand ?? '(không có)'}`,
    `TYPE / NGÁCH (từ sheet): ${sheet.type ?? '(không có)'}`,
    `Giá nguồn COST: ${sheet.cost ?? '(không có)'} — chỉ để tham khảo, KHÔNG dùng để quyết giá bán`,
    `GIÁ BÁN đã chốt trong sheet: ${sheet.gia_ban ?? '(không có)'} — đã có sẵn, không tính lại`,
    `Mô tả: ${stripHtmlToText(p.description ?? p.description_text ?? '') || '(không có)'}`,
    `Specs: ${JSON.stringify(p.specs ?? {})}`,
    `Attributes: ${JSON.stringify(p.attributes ?? {})}`,
    `Biến thể (tối đa 10): ${JSON.stringify(variants)}`,
  ].join('\n');
  return { system, user };
}

// ---- parse JSON từ LLM -------------------------------------------------------

/** Trích object JSON từ text LLM (chấp nhận ```json fence hoặc text thừa). */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('LLM trả về rỗng');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM không trả JSON hợp lệ');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Trích MẢNG JSON từ text LLM (gom nhóm trả về mảng [{...}, ...] — hàm
 * extractJsonObject chỉ lấy được object nên với mảng nó sẽ cắt nhầm thành
 * object đầu tiên). Chấp nhận ```json fence hoặc text thừa.
 */
export function extractJsonArray(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('LLM trả về rỗng');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM không trả mảng JSON hợp lệ');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('LLM không trả mảng JSON hợp lệ');
  return parsed;
}

// ---- kiểm chứng gợi ý LLM ----------------------------------------------------

/**
 * Kiểm chứng gợi ý thô từ LLM trước khi trả về:
 * - title cắt tối đa 80 ký tự (truncateTitle).
 * - ebayType: chỉ nhận đúng 1 trong 22 giá trị cho phép (khớp không phân
 *   biệt hoa/thường rồi chuẩn hoá về dạng chuẩn); ngoài danh sách -> null
 *   + warning, KHÔNG tự đoán thay.
 * - specifics: chỉ nhận khía cạnh trong AI_SPECIFIC_ASPECTS, giá trị string
 *   không rỗng; Brand luôn lấy từ sản phẩm/sheet, LLM không được bịa Brand.
 * - category: lấy từ gợi ý LLM nếu có, không thì fallback theo luật
 *   (edits.category / product.category / suggestCategory).
 * Trả {suggestion: {title, category, ebayType, specifics}, warnings}.
 */
export function normalizeLlmSuggestion(raw, product) {
  const warnings = [];
  const p = product ?? {};
  const r = raw && typeof raw === 'object' ? raw : {};
  const title = truncateTitle(r.title ?? p.title ?? p.title_raw ?? '', MAX_TITLE_LENGTH);
  if (!title) warnings.push('missing title');

  let ebayType = null;
  const rawType = r.ebayType ?? r.type ?? null;
  if (rawType != null && String(rawType).trim() !== '') {
    const match = EBAY_TYPES_20563.find((v) => v.toLowerCase() === String(rawType).trim().toLowerCase());
    if (match) ebayType = match;
    else {
      warnings.push(`AI gợi ý Type "${String(rawType).trim()}" ngoài danh sách cho phép — để trống, team tự điền`);
    }
  } else {
    warnings.push('AI không gợi ý được Type — để trống, team tự điền');
  }

  const category = (typeof r.category === 'string' && r.category.trim())
    ? r.category.trim()
    : (p.edits?.category ?? p.category ?? p.suggested_category ?? suggestCategory(p.title ?? '', p.source_site) ?? null);
  if (!category) warnings.push('missing category');

  const specifics = {};
  const rawSpecifics = (r.specifics && typeof r.specifics === 'object' && !Array.isArray(r.specifics))
    ? r.specifics
    : (r.itemSpecifics && typeof r.itemSpecifics === 'object' ? r.itemSpecifics : {});
  for (const [key, value] of Object.entries(rawSpecifics)) {
    const canonical = AI_SPECIFIC_ASPECTS.find((a) => a.toLowerCase() === String(key).trim().toLowerCase());
    if (!canonical) continue; // Khía cạnh không có trong template thì bỏ.
    const v = value == null ? '' : String(value).trim();
    if (v) specifics[canonical] = v.slice(0, 200);
  }
  // Brand: LUÔN lấy từ sản phẩm/sheet, không lấy Brand do LLM bịa.
  if (p.brand && String(p.brand).trim()) specifics.Brand = String(p.brand).trim();

  return {
    suggestion: { title, category, ebayType, specifics },
    warnings,
  };
}

// ---- gọi LLM (fetch có timeout) ---------------------------------------------

/** Fetch có timeout: đua fetch với promise timeout — chỉ abort() signal thì
 *  chưa đủ, vì một fetch treo (promise không bao giờ settle) sẽ không bị
 *  reject khi signal abort. Timeout 20s mặc định (AI_TIMEOUT_MS). */
async function fetchWithTimeout(url, init, fetchFn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`AI timeout sau ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`AI timeout sau ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function llmHttpError(res, providerName) {
  if (res.status === 429) {
    return new Error(providerName === 'Gemini'
      ? 'AI chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại; nếu vẫn lỗi, kiểm tra quota của model/project trong Google AI Studio'
      : 'AI chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại; nếu vẫn lỗi, kiểm tra quota của tài khoản tại nhà cung cấp');
  }
  return new Error(`${providerName} lỗi HTTP ${res.status}`);
}

/** Lỗi có phải do chạm giới hạn request (429) không — client dùng để dừng
 *  gợi ý hàng loạt thay vì gọi tiếp. */
export function isRateLimitError(error) {
  return /429|chạm giới hạn request/i.test(String(error?.message ?? error ?? ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OpenAI-compatible chat completions (mặc định api.openai.com, model
 * gpt-4o-mini; base URL + model cấu hình được để dùng API tương thích).
 * Trả object JSON đã parse từ message.content (jsonKind 'array' thì trả
 * mảng JSON — dùng cho gom nhóm).
 */
export async function callOpenAiCompatible({ baseUrl, model, apiKey, system, user, fetchFn = globalThis.fetch, timeoutMs = AI_TIMEOUT_MS, jsonKind = 'object' }) {
  const url = baseUrl || DEFAULT_AI_BASE_URLS.openai;
  const payload = (withFormat) => ({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: AI_MAX_TOKENS,
    ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  let res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload(true)) }, fetchFn, timeoutMs);
  if (res.status === 400) {
    // Một số API tương thích không hỗ trợ response_format: thử lại không có nó.
    res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload(false)) }, fetchFn, timeoutMs);
  }
  if (!res.ok) throw llmHttpError(res, 'OpenAI');
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('OpenAI trả về rỗng');
  return jsonKind === 'array' ? extractJsonArray(content) : extractJsonObject(content);
}

function geminiModelId(name) {
  const id = String(name ?? '').trim().replace(/^models\//, '');
  return /^[a-zA-Z0-9._-]+$/.test(id) ? id : null;
}

function textFlashModels(models, excluded) {
  const candidates = new Set();
  for (const entry of models) {
    const id = geminiModelId(entry?.name);
    if (!id || id === excluded || !Array.isArray(entry?.supportedGenerationMethods)
      || !entry.supportedGenerationMethods.includes('generateContent')) continue;
    // Do not silently switch to Pro or media-only generation models.
    if (!/^gemini-.*flash/i.test(id) || /(?:image|audio|tts|live|embedding|robotics|computer-use)/i.test(id)) continue;
    candidates.add(id);
  }
  const rank = (id) => (/preview|experimental|(?:^|-)exp(?:-|$)/i.test(id) ? 100 : 0) + (/flash-lite/i.test(id) ? 0 : 10);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * Gemini JSON generation. A 404 triggers bounded ListModels discovery and
 * retries only returned text Flash models that support generateContent.
 * The whole recovery shares one timeout. 401/403/429 never trigger retries.
 * Keys stay in the x-goog-api-key header; errors never include response bodies.
 * Docs: https://aistudio.google.com/api-reference/models/list-models
 */
export async function callGemini({ baseUrl, model, apiKey, system, user, fetchFn = globalThis.fetch, timeoutMs = AI_TIMEOUT_MS, jsonKind = 'object', onModelResolved }) {
  const base = (baseUrl || DEFAULT_AI_BASE_URLS.gemini).replace(/\/+$/, '');
  const requestedModel = geminiModelId(model ?? DEFAULT_AI_MODELS.gemini);
  if (!requestedModel) throw new Error('Tên model Gemini không hợp lệ — nhập mã model hoặc models/<mã model>');
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error(`AI timeout sau ${Math.round(timeoutMs / 1000)}s`);
    return ms;
  };
  const attempt = (m) => fetchWithTimeout(`${base}/models/${encodeURIComponent(m)}:generateContent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      // New Gemini generations deprecate sampling parameters. Defaults work
      // across generations; keep only the JSON format and output budget.
      generationConfig: { maxOutputTokens: AI_MAX_TOKENS, responseMimeType: 'application/json' },
    }),
  }, fetchFn, remaining());
  let effectiveModel = requestedModel;
  let res = await attempt(effectiveModel);
  if (res.status === 404) {
    const models = [];
    const seenTokens = new Set();
    let pageToken = null;
    for (let page = 0; page < GEMINI_MODEL_DISCOVERY_MAX_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const listed = await fetchWithTimeout(`${base}/models?${query}`, { method: 'GET', headers }, fetchFn, remaining());
      if (!listed.ok) throw llmHttpError(listed, 'Gemini ListModels');
      const data = await listed.json();
      if (Array.isArray(data?.models)) models.push(...data.models);
      pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : null;
      if (!pageToken || seenTokens.has(pageToken)) break;
      seenTokens.add(pageToken);
    }
    const alternatives = textFlashModels(models, requestedModel).slice(0, GEMINI_MODEL_RECOVERY_ATTEMPTS);
    for (const candidate of alternatives) {
      effectiveModel = candidate;
      res = await attempt(candidate);
      if (res.status !== 404) break;
    }
    if (res.status === 404) {
      throw new Error(`Gemini lỗi HTTP 404 — model "${requestedModel}" không dùng được; không tìm được model Flash hỗ trợ generateContent hoạt động qua ListModels. Kiểm tra model/quyền truy cập trong Google AI Studio (đã cấu hình key).`);
    }
  }
  if (!res.ok) throw llmHttpError(res, 'Gemini');
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part?.text ?? '').join('');
  if (!text.trim()) throw new Error('Gemini trả về rỗng');
  const result = jsonKind === 'array' ? extractJsonArray(text) : extractJsonObject(text);
  if (typeof onModelResolved === 'function') onModelResolved(effectiveModel);
  return result;
}

// ---- runtime: key + provider/model (env trước, RAM sau) ----------------------

/** Lấy env AI_* từ một object env (process.env ở dev, env Workers khi deploy).
 *  Key CHỈ kiểm tra không rỗng — KHÔNG kiểm tra tiền tố: key AI Studio mới
 *  bắt đầu bằng "AQ.", key cũ bắt đầu bằng "AIza", cả hai đều đúng. */
export function pickAiEnv(env) {
  const e = env ?? {};
  const interval = Number(e.AI_MIN_INTERVAL_MS);
  return {
    apiKey: typeof e.AI_API_KEY === 'string' && e.AI_API_KEY.trim() ? e.AI_API_KEY.trim() : null,
    provider: typeof e.AI_PROVIDER === 'string' && e.AI_PROVIDER.trim() ? e.AI_PROVIDER.trim().toLowerCase() : null,
    model: typeof e.AI_MODEL === 'string' && e.AI_MODEL.trim() ? e.AI_MODEL.trim() : null,
    baseUrl: typeof e.AI_BASE_URL === 'string' && e.AI_BASE_URL.trim() ? e.AI_BASE_URL.trim() : null,
    minIntervalMs: Number.isFinite(interval) && interval >= 0 ? interval : null,
  };
}

export class AiRuntime {
  #geminiResolution = null;

  constructor(env = {}) {
    this.env = pickAiEnv(env);
    // Key dán trong web: chỉ trong RAM, mất khi restart, không ghi file/log.
    this.memory = { apiKey: null, provider: null, model: null, baseUrl: null };
    this.fetchFn = globalThis.fetch;
    this.lastCallAt = 0; // Thời điểm lần gọi LLM gần nhất (để giãn cách, xem waitForRateLimit).
  }

  /** Đưa env mới vào runtime (dev-server lúc khởi động / Workers mỗi request). */
  applyEnv(env) {
    const next = pickAiEnv(env);
    this.env = {
      apiKey: next.apiKey ?? this.env.apiKey,
      provider: next.provider ?? this.env.provider,
      model: next.model ?? this.env.model,
      baseUrl: next.baseUrl ?? this.env.baseUrl,
      minIntervalMs: next.minIntervalMs ?? this.env.minIntervalMs,
    };
    return this.getStatus();
  }

  /**
   * Giãn cách tối thiểu giữa 2 lần gọi LLM (ms): ưu tiên env
   * AI_MIN_INTERVAL_MS nếu có; không thì Gemini = 4.000ms, OpenAI = 0.
   * Giãn cách này không bảo đảm tránh mọi giới hạn của nhà cung cấp.
   */
  getMinIntervalMs() {
    const raw = this.env.minIntervalMs;
    if (raw != null) {
      const fromEnv = Number(raw);
      if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    }
    const provider = this.getEffectiveConfig().provider;
    return provider === 'gemini' ? GEMINI_FREE_TIER_MIN_INTERVAL_MS : OPENAI_MIN_INTERVAL_MS;
  }

  /** Đợi đủ giãn cách kể từ lần gọi LLM trước (gợi ý hàng loạt gọi tuần
   *  tự nên mỗi request sẽ cách nhau ít nhất khoảng này). */
  async waitForRateLimit() {
    const interval = this.getMinIntervalMs();
    if (!interval) return;
    // Giữ chỗ (reserve) lượt gọi TRƯỚC khi await: 2 request đồng thời
    // (2 tab / extension + web) không cùng đọc lastCallAt cũ rồi gọi LLM
    // cùng lúc — lượt sau xếp hàng sau lượt trước đúng 1 khoảng giãn cách.
    const now = Date.now();
    const at = Math.max(now, (this.lastCallAt ?? 0) + interval);
    this.lastCallAt = at;
    if (at > now) await sleep(at - now);
  }

  /** Cấu hình hiệu lực: key lấy env trước rồi mới tới key dán trong web;
   *  provider/model/baseUrl lấy key dán trong web trước rồi mới tới env. */
  getEffectiveConfig() {
    const provider = this.memory.provider ?? this.env.provider ?? 'openai';
    const safeProvider = AI_PROVIDERS.includes(provider) ? provider : 'openai';
    // Bảo mật: khi key lấy từ env (AI_API_KEY), KHÔNG dùng baseUrl dán trong
    // web — nếu không, ai gọi được POST /api/ai/config {baseUrl} sẽ khiến
    // server gửi key env tới URL của họ. baseUrl web chỉ áp cho key web.
    const memoryBaseUrl = this.env.apiKey ? null : this.memory.baseUrl;
    return {
      provider: safeProvider,
      model: this.memory.model ?? this.env.model ?? DEFAULT_AI_MODELS[safeProvider],
      baseUrl: memoryBaseUrl ?? this.env.baseUrl ?? DEFAULT_AI_BASE_URLS[safeProvider],
      apiKey: this.env.apiKey ?? this.memory.apiKey ?? null,
      source: this.env.apiKey ? 'env' : (this.memory.apiKey ? 'web' : 'none'),
    };
  }

  /** Trạng thái an toàn để trả ra ngoài: KHÔNG BAO GIỜ chứa key. */
  getStatus() {
    const cfg = this.getEffectiveConfig();
    const resolved = this.getResolvedGeminiModel(cfg);
    return { configured: Boolean(cfg.apiKey), provider: cfg.provider, model: resolved ?? cfg.model, source: cfg.source,
      ...(resolved && resolved !== cfg.model ? { configuredModel: cfg.model } : {}) };
  }

  getResolvedGeminiModel(cfg = this.getEffectiveConfig()) {
    const cached = this.#geminiResolution;
    return cfg.provider === 'gemini' && cached && cached.apiKey === cfg.apiKey
      && cached.baseUrl === cfg.baseUrl && cached.requestedModel === cfg.model ? cached.model : null;
  }

  /**
   * Lưu cấu hình dán trong web vào RAM. apiKey: chuỗi không rỗng -> lưu;
   * '' -> xoá key trong RAM; undefined -> giữ nguyên. Không trả key ra.
   */
  setMemoryConfig({ provider, model, baseUrl, apiKey } = {}) {
    if (provider !== undefined && provider !== null && String(provider).trim() !== '') {
      const p = String(provider).trim().toLowerCase();
      if (!AI_PROVIDERS.includes(p)) throw { code: 'invalid_provider', provider: p };
      this.memory.provider = p;
    }
    if (model !== undefined && model !== null && String(model).trim() !== '') this.memory.model = String(model).trim();
    if (baseUrl !== undefined && baseUrl !== null && String(baseUrl).trim() !== '') {
      const value = String(baseUrl).trim();
      let parsed = null;
      try { parsed = new URL(value); } catch { /* xử lý bên dưới */ }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) throw { code: 'invalid_base_url' };
      this.memory.baseUrl = value;
    }
    if (apiKey !== undefined) {
      this.memory.apiKey = (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : null;
    }
    return this.getStatus();
  }

  clearMemoryConfig() {
    this.memory = { apiKey: null, provider: null, model: null, baseUrl: null };
    return this.getStatus();
  }

  /**
   * Gọi LLM với prompt hệ thống + người dùng tùy ý, trả object JSON đã
   * parse (dùng chung cho gợi ý từng sản phẩm và gom nhóm nhiều sản phẩm).
   * jsonKind 'array' thì trả mảng JSON (gom nhóm). Mỗi lần gọi đều đợi đủ
   * giãn cách tối thiểu trước (Gemini mặc định: ~4 giây/lần gọi).
   * Không có key -> null.
   */
  async callLlmJson(system, user, { timeoutMs = AI_TIMEOUT_MS, jsonKind = 'object' } = {}) {
    const cfg = this.getEffectiveConfig();
    if (!cfg.apiKey) return null;
    await this.waitForRateLimit();
    if (cfg.provider === 'gemini') {
      return callGemini({ baseUrl: cfg.baseUrl, model: this.getResolvedGeminiModel(cfg) ?? cfg.model,
        apiKey: cfg.apiKey, system, user, fetchFn: this.fetchFn, timeoutMs, jsonKind,
        onModelResolved: (model) => {
          this.#geminiResolution = { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, requestedModel: cfg.model, model };
        } });
    }
    return callOpenAiCompatible({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, system, user, fetchFn: this.fetchFn, timeoutMs, jsonKind });
  }

  /** Trả hàm provider (product) => raw suggestion, hoặc null khi chưa có key.
   *  Mỗi lần gọi đều đợi đủ giãn cách tối thiểu trước (Gemini mặc định:
   *  ~4 giây/lần gọi). */
  getProviderFn() {
    const cfg = this.getEffectiveConfig();
    if (!cfg.apiKey) return null;
    return async (product) => {
      const prompt = buildAiPrompt(product);
      return this.callLlmJson(prompt.system, prompt.user);
    };
  }
}

/** Singleton dùng chung cho dev-server và Workers. */
export const defaultAiRuntime = new AiRuntime();

export function applyEnvToRuntime(runtime, env) {
  return runtime.applyEnv(env);
}

export default { AiRuntime, defaultAiRuntime, buildAiPrompt, normalizeLlmSuggestion, callOpenAiCompatible, callGemini };
