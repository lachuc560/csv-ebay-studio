// server/ai.mjs — Gợi ý AI cho listing eBay (title/category/item specifics).
// Chỉ TRẢ gợi ý + warnings, KHÔNG tự áp dụng vào product — team duyệt rồi mới lưu.
// Không có provider thì gợi ý theo luật từ public/core.js.

import {
  MAX_TITLE_LENGTH, EBAY_TYPES_20563, groupProductsByTheme, mapEbayType,
  slugifyTheme, suggestCategory, truncateTitle,
} from '../public/core.js';
import { normalizeLlmSuggestion, stripHtmlToText, isRateLimitError } from './ai-providers.mjs';

/**
 * Kiểm tra một gợi ý: title ≤ 80 ký tự, item specifics là string không rỗng,
 * category có mặt. Trả {ok, warnings[]}; ok=false khi có warning.
 * Chấp nhận specifics ở `specifics` hoặc `itemSpecifics`.
 */
export function validateAiSuggestion(suggestion) {
  const warnings = [];
  const s = suggestion && typeof suggestion === 'object' ? suggestion : {};
  const title = s.title;
  if (title == null || String(title).trim() === '') {
    warnings.push('missing title');
  } else if (String(title).length > MAX_TITLE_LENGTH) {
    warnings.push(`title exceeds ${MAX_TITLE_LENGTH} characters`);
  }
  if (!s.category || String(s.category).trim() === '') {
    warnings.push('missing category');
  }
  const specifics = s.specifics ?? s.itemSpecifics ?? null;
  if (specifics == null) {
    warnings.push('missing item specifics');
  } else if (typeof specifics !== 'object' || Array.isArray(specifics)) {
    warnings.push('item specifics must be an object');
  } else {
    for (const [key, value] of Object.entries(specifics)) {
      if (value == null || String(value).trim() === '') {
        warnings.push(`item specific "${key}" is empty`);
      }
    }
    if (Object.keys(specifics).length === 0) warnings.push('item specifics are empty');
  }
  return { ok: warnings.length === 0, warnings };
}

function uniqueValues(variants, optionName) {
  const seen = new Set();
  for (const v of variants ?? []) {
    const val = v?.options?.[optionName];
    if (val != null && String(val).trim() !== '') seen.add(String(val).trim());
  }
  return [...seen];
}

/** Gợi ý theo luật (không cần provider): title truncate 80, category từ core, specifics Brand/Size/Color. */
export function ruleBasedSuggestion(product) {
  const edits = product.edits ?? {};
  const rawTitle = edits.title ?? product.title ?? product.title_raw ?? '';
  const title = truncateTitle(rawTitle, MAX_TITLE_LENGTH);
  const category = edits.category
    ?? product.category
    ?? product.suggested_category
    ?? suggestCategory(rawTitle, product.source_site)
    ?? null;
  const specifics = {};
  if (product.brand) specifics.Brand = String(product.brand).trim();
  const sizes = uniqueValues(product.variants, 'Size');
  if (sizes.length) specifics.Size = sizes.join(', ');
  const colors = uniqueValues(product.variants, 'Color');
  if (colors.length) specifics.Color = colors.join(', ');
  const suggestion = { title, category, ebayType: null, specifics };
  const { warnings } = validateAiSuggestion(suggestion);
  if (product.price_estimated) {
    warnings.push('price is estimated — verify the source price before listing');
  }
  if (product.price == null) {
    warnings.push('product has no price — set a price before listing');
  }
  if (!product.images?.length) {
    warnings.push('product has no images');
  }
  return { suggestion, warnings };
}

/**
 * Gợi ý cho một product.
 * @param {object} product - product đã chuẩn hoá (core.normalizeRecord)
 * @param {function} [provider] - fn async tuỳ chọn (product) => suggestion
 *   thô từ LLM (vd AiRuntime.getProviderFn()). Gợi ý LLM luôn được kiểm
 *   chứng bằng normalizeLlmSuggestion: title ≤80, ebayType chỉ trong 22
 *   giá trị cho phép của template 20563, Brand lấy từ sản phẩm/sheet.
 *   Provider lỗi / timeout / trả JSON hỏng -> fallback về gợi ý theo luật
 *   kèm warning rõ lý do, KHÔNG crash.
 * @param {object} [opts] - { providerName } để ghi vào kết quả (vd 'openai').
 * @returns {Promise<{suggestion: {title, category, ebayType, specifics}, warnings: string[], provider: string}>}
 *   provider: 'rule-based' khi chưa có key AI hoặc khi LLM lỗi và đã fallback.
 */
export async function suggestFromProduct(product, provider, opts = {}) {
  if (!product || typeof product !== 'object') {
    throw { code: 'product_required' };
  }
  if (typeof provider === 'function') {
    try {
      const raw = await provider(product);
      const { suggestion, warnings } = normalizeLlmSuggestion(raw, product);
      return { suggestion, warnings, provider: opts.providerName ?? 'llm' };
    } catch (e) {
      const base = ruleBasedSuggestion(product);
      const reason = e?.message ? String(e.message) : 'lỗi không rõ';
      return {
        suggestion: base.suggestion,
        warnings: [...base.warnings, `AI lỗi (${reason}) — dùng gợi ý theo luật`],
        provider: 'rule-based',
      };
    }
  }
  const base = ruleBasedSuggestion(product);
  return { ...base, provider: 'rule-based' };
}

/**
 * Gợi ý qua AiRuntime: có key thì gọi LLM thật, không có key thì gợi ý
 * theo luật. Trả thêm cờ provider để giao diện hiển thị rõ nguồn gợi ý.
 */
export async function suggestWithRuntime(product, runtime) {
  if (!runtime || typeof runtime.getProviderFn !== 'function') {
    return suggestFromProduct(product);
  }
  const providerFn = runtime.getProviderFn();
  if (!providerFn) return suggestFromProduct(product);
  const status = runtime.getStatus();
  return suggestFromProduct(product, providerFn, { providerName: status.provider });
}

// ---- Trích xuất 1 trang sản phẩm bằng AI (v9) -----------------------------
// Seller mở 1 trang sản phẩm trên web bán lẻ, extension đọc dữ liệu trang
// (JSON-LD + biến thể + text hiển thị, tối đa 12.000 ký tự) rồi gửi về
// server; LLM trích xuất JSON có cấu trúc: title, price, currency, images,
// description, material, dimensions, variants[] (mỗi biến thể: {color,
// size, price, stock}).
// QUY TẮC BẮT BUỘC (user chốt 16/11/2026): SIZE và MÀU lấy ưu tiên từ
// trang gốc; trường nào trang không có thì để null + warning, KHÔNG bịa
// giá trị; title cắt ≤80 ký tự; giá lấy giá non-member hiển thị trên trang
// (vd Soho Home: JSON-LD offers.price, KHÔNG lấy Member price).
// Không có key AI hoặc LLM lỗi -> fallback theo luật từ dữ liệu trang đã
// đọc (reader), kèm warning rõ lý do, KHÔNG crash.

/** Đoạn text hiển thị tối đa gửi LLM khi trích xuất 1 trang. */
export const AI_EXTRACT_PAGE_MAX_CHARS = 12000;
/** Số trang tối đa trong 1 lần gọi extract hàng loạt. */
export const AI_EXTRACT_PAGES_MAX = 20;

function cleanExtractString(value, maxLen = 500) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, maxLen) : null;
}

function cleanExtractPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanExtractImages(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v ?? '').trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 24);
}

function pageVariants(raw) {
  return Array.isArray(raw?.variants)
    ? raw.variants.filter((v) => v && typeof v === 'object' && !Array.isArray(v))
    : [];
}

function pageVariantOptions(variant) {
  const options = {};
  for (const source of [variant?.options, variant?.extra_options]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [name, value] of Object.entries(source)) {
      const clean = cleanExtractString(value, 100);
      if (name.trim() && clean != null && !Object.hasOwn(options, name.trim())) {
        Object.defineProperty(options, name.trim(), { value: clean, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  if (variant?.color != null && !Object.keys(options).some((key) => /^colou?r$/i.test(key))) options.Color = cleanExtractString(variant.color, 100);
  if (variant?.size != null && !Object.keys(options).some((key) => /^size$/i.test(key))) options.Size = cleanExtractString(variant.size, 100);
  return options;
}

function pageVariantStock(variant) {
  const stock = Object.hasOwn(variant ?? {}, 'in_stock') ? variant.in_stock : (variant?.inStock ?? variant?.stock);
  if (Number.isFinite(variant?.stock_qty) && variant.stock_qty === 0) return false;
  return typeof stock === 'boolean' ? stock : null;
}

// ---- Trích xuất xác định từ panel "Details & Dimensions" của Soho Home (v9.5) ----
// Trang Soho Home có đủ dữ liệu (giá JSON-LD, mô tả + thông số trong panel
// "Details & Dimensions", gallery ảnh) nhưng luồng trích xuất cũ chỉ dùng
// được khi reader của extension đọc đủ panel đó HOẶC khi có key AI. Panel
// là accordion nên innerText lúc extension đọc có thể thiếu nó — lúc đó
// pageText (text hiển thị, extension luôn gửi kèm, tối đa 12.000 ký tự)
// vẫn chứa panel, nên server tự đào panel từ pageText, KHÔNG cần key AI.
// Không bịa: nhãn nào không có trong text thì specs không có nhãn đó;
// SKU / tên màu / variant / số đã bán KHÔNG có trên trang thì không suy
// ra từ đây — các trường đó vẫn null + warning như cũ.

/** Nhãn thông số trong panel "Details & Dimensions" của Soho Home (cùng bộ nhãn extension dùng). */
export const SOHO_DETAIL_LABELS = [
  'Dimensions', 'Packaged dimensions', 'Assembled size', 'Base dimensions', 'Weight', 'Packaged weight',
  'Material', 'Frame', 'Composition', 'Care instructions',
  'Assembly required', 'Clearance', 'Feet', 'Marble type', 'Handmade',
  'Pile', 'Rug style', 'Technique',
  // Đèn (v9.5): panel của đèn có thêm các nhãn này (vd Fleur Table Lamp).
  'Bulb type', 'Bulb', 'Number of bulbs', 'Bulb included', 'Wattage',
  'Light source', 'Dimmable', 'Switch', 'Cable length', 'Cable colour',
  'Voltage', 'Shade', 'Base',
  // Đèn tường (v9.7, Floria Wall Light 18/11/2026): Soho dùng nhãn khác
  // hẳn — 'Bulb required' / 'Bulb style' thay cho 'Bulb type', kèm
  // 'Bulb(s) included', 'Electrician required', 'IP Rating', 'Bathroom safe'.
  'Bulb required', 'Bulb style', 'Bulb(s) included',
  'Electrician required', 'Lighting Certification US', 'IP Rating', 'Bathroom safe',
];

function cleanSohoDescription(text) {
  return String(text ?? '').replace(/(?:^|\s+)Download\s+tearsheet\s*$/i, '').trim() || null;
}

function isSohoHomeSource(raw) {
  if (/^soho\s*home$/i.test(String(raw?.sourceSite ?? raw?.source_site ?? ''))) return true;
  try { return /(^|\.)sohohome\.com$/i.test(new URL(raw?.url ?? raw?.source_url ?? '').hostname); }
  catch { return false; }
}

/** Từ chất liệu thường gặp trong mô tả Soho Home (để suy cụm chất liệu từ câu mô tả). */
const MATERIAL_KEYWORDS = [
  'glass', 'metal', 'wood', 'ceramic', 'marble', 'brass', 'steel', 'iron',
  'rattan', 'wicker', 'linen', 'cotton', 'wool', 'velvet', 'leather',
  'stone', 'resin', 'plastic', 'acrylic', 'chrome', 'copper', 'oak',
  'walnut', 'pine', 'fabric', 'polyester', 'viscose', 'rayon', 'jute',
  'bamboo', 'paper', 'porcelain', 'terracotta', 'concrete', 'aluminium',
  'aluminum', 'ash', 'walnut', 'mahogany', 'teak',
];

/**
 * Suy cụm chất liệu từ câu mô tả (khi trang không có nhãn "Material:" riêng):
 * lấy câu đầu tiên nhắc tới 1 chất liệu, cắt ở động từ chính ("are formed",
 * "is made"...) để chỉ giữ cụm danh từ chất liệu. Vd câu
 * "Milky-white glass and lacquered sprayed metals are formed into an
 * Art Deco-inspired silhouette." -> "Milky-white glass and lacquered
 * sprayed metals". Không có câu nào nhắc chất liệu thì null, không bịa.
 */
export function materialPhraseFromDescription(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!MATERIAL_KEYWORDS.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(lower))) continue;
    const cut = sentence.search(/\s+(are|is|was|were|form|forms|formed|feature|features|make|makes|made|create|creates|give|gives|bring|brings|stand|stands|sit|sits|measure|measures|weigh|weighs|come|comes)\b/i);
    let phrase = (cut > 0 ? sentence.slice(0, cut) : sentence).trim().replace(/[.,;:]+$/, '').trim();
    phrase = phrase.replace(/^(made (of|from)|crafted (of|from)|in|with|features?)\s+/i, '').trim();
    // "Solid oak and brass, this table stands..." — cắt ở dấu phẩy đầu
    // tiên khi sau nó là 1 mệnh đề mới (this/that/it/the... hoặc có động
    // từ), giữ nguyên khi sau nó là liệt kê chất liệu (brass, glass...).
    const commaIdx = phrase.indexOf(', ');
    if (commaIdx > 0) {
      const after = phrase.slice(commaIdx + 2).trim().toLowerCase();
      const clauseStart = /^(this|that|it|the|a|an|its|their|featuring|including)\b/.test(after)
        || /\b(stands?|sits?|measures?|weighs?|comes?|features?|has|have|is|are|was|were|offers?)\b/.test(after);
      if (clauseStart) phrase = phrase.slice(0, commaIdx).trim();
    }
    if (phrase) return (phrase.charAt(0).toUpperCase() + phrase.slice(1)).slice(0, 200);
  }
  return null;
}

/**
 * Đào panel "Details & Dimensions" từ text hiển thị đã làm phẳng (1 dòng,
 * khoảng trắng đơn — đúng dạng pageText extension gửi): đoạn mở đầu trước
 * nhãn đầu tiên là mô tả, sau đó là các cặp nhãn → giá trị (nhãn có thể
 * kèm dấu ':' hoặc không). Nhãn lặp lại ngay sau chính nó (vd "Switch ...
 * switch" trong giá trị) được gộp vào giá trị trước, không tách thành
 * nhãn mới. Không có tiêu đề panel thì chỉ đào specs, KHÔNG đoán mô tả
 * từ đầu trang (đầu trang có giá/tiêu đề, không phải mô tả).
 * Trả {description, specs} — description null khi không có đoạn mở đầu
 * đủ dài, specs {} khi không nhận ra nhãn nào.
 */
export function parseSohoDetailsText(pageText) {
  const flat = String(pageText ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return { description: null, specs: {} };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = [...SOHO_DETAIL_LABELS].sort((a, b) => b.length - a.length);
  const labelPattern = new RegExp(`\\b(${labels.map(escapeRe).join('|')})(\\s*:)?(?=\\s|$)`, 'gi');
  let body = flat;
  let hasPanel = false;
  const panelIdx = flat.search(/details\s*&\s*dimensions/i);
  if (panelIdx >= 0) {
    hasPanel = true;
    body = flat.slice(panelIdx).replace(/^details\s*&\s*dimensions\s*:?\s*/i, '');
    // Cắt ở panel sau (Delivery / Returns) — phần sau đó không còn là thông số.
    const cut = body.search(/\bdelivery\s*&\s*returns\b/i);
    if (cut >= 0) body = body.slice(0, cut);
  }
  const canonical = (matched) => labels.find((l) => l.toLowerCase() === String(matched).toLowerCase()) ?? matched;
  // Từ thường đứng sau 1 từ trong câu (động từ, mạo từ, giới từ...) — nhãn
  // thật luôn đi kèm giá trị (số, kích thước, mã, từ viết hoa), nên lần
  // xuất hiện của 1 nhãn mà sau nó là từ này thì đó chỉ là 1 từ trong câu
  // mô tả (vd "half-sphere shade is paired..." — "shade" không phải nhãn),
  // bỏ qua, không cắt mô tả ở đó.
  const STOP_WORDS = new Set([
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
    'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
    'must', 'does', 'do', 'did', 'the', 'a', 'an', 'and', 'or', 'but',
    'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as',
    'it', 'its', 'this', 'that', 'these', 'those', 'which', 'who', 'whom',
    'when', 'where', 'while', 'after', 'before', 'into', 'over', 'under',
    'between', 'through', 'during', 'per', 'via', 'your', 'our', 'their',
    'his', 'her', 'my', 'me', 'we', 'you', 'they', 'he', 'she',
  ]);
  const hits = [];
  let m;
  labelPattern.lastIndex = 0;
  while ((m = labelPattern.exec(body)) !== null) {
    const after = body.slice(m.index + m[0].length).trimStart();
    // Từ tiếp theo (giữ nguyên từ có gạch nối như "In-line" — chỉ lấy
    // phần trước gạch nối thì "In" sẽ bị nhầm thành giới từ "in").
    const nextWord = (after.match(/^[A-Za-z]+(?:-[A-Za-z]+)*/) ?? [''])[0].toLowerCase();
    if (STOP_WORDS.has(nextWord)) continue;
    hits.push({ index: m.index, end: m.index + m[0].length, label: canonical(m[1]) });
    if (m[0].length === 0) labelPattern.lastIndex++;
  }
  // Nhãn lặp lại ngay sau chính nó là một phần của giá trị trước đó.
  const deduped = [];
  for (const h of hits) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.label.toLowerCase() === h.label.toLowerCase()) continue;
    deduped.push(h);
  }
  const specs = {};
  let description = null;
  if (deduped.length) {
    const first = deduped[0];
    if (hasPanel) {
      const intro = body.slice(0, first.index).trim();
      if (intro.length >= 20) description = intro.slice(0, 2000);
    }
    for (let i = 0; i < deduped.length; i++) {
      const h = deduped[i];
      const next = deduped[i + 1];
      const value = body.slice(h.end, next ? next.index : body.length).trim().replace(/\s+/g, ' ');
      if (value) specs[h.label] = value.slice(0, 300);
    }
  } else if (hasPanel) {
    // Có panel nhưng không nhận ra nhãn nào: toàn bộ panel là mô tả.
    const intro = body.trim();
    if (intro.length >= 20) description = intro.slice(0, 2000);
  }
  return { description: cleanSohoDescription(description), specs };
}

/**
 * Bổ sung dữ liệu trang đã đọc bằng panel "Details & Dimensions" đào từ
 * pageText: mô tả lấy từ đoạn mở đầu panel khi reader chưa có; specs lấy
 * từ panel, reader thắng khi cả hai đều có cùng nhãn. Lặp lại vẫn cho kết
 * quả như cũ (idempotent) nên dùng chung cho cả đường LLM lẫn đường luật.
 */
export function enrichRawWithPageDetails(raw) {
  const r = raw ?? {};
  const mined = parseSohoDetailsText(r.pageText ?? '');
  return {
    ...r,
    description: r.description ?? r.description_text ?? mined.description ?? null,
    specs: { ...mined.specs, ...(r.specs ?? {}) },
  };
}

/**
 * Prompt trích xuất 1 trang: dữ liệu trang đã đọc (reader) + text hiển thị.
 * Yêu cầu LLM trả JSON duy nhất: {title, price, currency, images,
 * description, material, dimensions, variants: [{color, size, price,
 * stock}]}. Màu/size lấy từ trang gốc; không có thì null, không bịa.
 */
export function buildAiExtractPagePrompt(raw) {
  const r = raw ?? {};
  const readerVariants = pageVariants(r).slice(0, 20).map((v) => ({
    options: pageVariantOptions(v),
    sku: v.sku ?? null,
    price: v?.price ?? null,
    currency: v.currency ?? r.currency ?? null,
    in_stock: pageVariantStock(v),
  }));
  const system = [
    'Bạn là trợ lý trích xuất thông tin sản phẩm từ 1 trang web bán lẻ để đăng bán trên eBay US.',
    'Chỉ trả về MỘT object JSON duy nhất, không giải thích, không markdown ngoài JSON:',
    '{"title": "...", "price": 123.45 hoặc null, "currency": "USD", "images": ["https://..."], "description": "...", "material": "..." hoặc null, "dimensions": "..." hoặc null, "variants": [{"color": "..." hoặc null, "size": "..." hoặc null, "price": 123.45 hoặc null, "stock": true}]}',
    'title: tiếng Anh, giữ tên thương hiệu + tên sản phẩm + đặc điểm chính, tối đa 80 ký tự.',
    'price: giá bán lẻ HIỂN THỊ trên trang (giá non-member, KHÔNG lấy giá Member/giá thành viên). Không thấy giá thì null, tuyệt đối không đoán giá.',
    'color/size của từng biến thể: LẤY TỪ TRANG GỐC (dữ liệu reader + text trang dưới đây). Trang không ghi màu/size thì để null, tuyệt đối không bịa màu/size từ tên sản phẩm.',
    'images: chỉ lấy URL ảnh sản phẩm có trong dữ liệu dưới đây, không bịa URL.',
    'description: mô tả ngắn gọn bằng tiếng Anh từ text trang; không có mô tả thì null.',
    'material/dimensions: chỉ lấy khi trang ghi rõ; không có thì null, không bịa.',
    'Chỉ suy ra từ dữ liệu dưới đây; thông tin nào không có thì để null.',
  ].join('\n');
  const user = [
    `URL trang: ${r.url ?? r.source_url ?? '(không có)'}`,
    `Site: ${r.sourceSite ?? r.source_site ?? '(không có)'}`,
    `Tiêu đề (reader): ${r.title ?? '(không có)'}`,
    `Giá (reader, non-member): ${r.price ?? '(không có)'} ${r.currency ?? ''}`,
    `Thương hiệu (reader): ${r.brand ?? '(không có)'}`,
    `Ảnh (reader): ${JSON.stringify((r.images ?? []).slice(0, 12))}`,
    `Mô tả (reader): ${stripHtmlToText(r.description ?? r.description_text ?? '') || '(không có)'}`,
    `Specs (reader): ${JSON.stringify(r.specs ?? {})}`,
    `Attributes (reader): ${JSON.stringify(r.attributes ?? {})}`,
    `Biến thể (reader, tối đa 20): ${JSON.stringify(readerVariants)}`,
    `Text hiển thị trên trang (tối đa ${AI_EXTRACT_PAGE_MAX_CHARS} ký tự): ${stripHtmlToText(r.pageText ?? '', AI_EXTRACT_PAGE_MAX_CHARS) || '(không có)'}`,
  ].join('\n');
  return { system, user };
}

/**
 * Kiểm chứng kết quả trích xuất thô từ LLM:
 * - title cắt ≤80 (truncateTitle); trống -> null + warning.
 * - price: số > 0 hoặc null + warning. CHỐNG BỊA: trang gốc không ghi giá
 *   (source.price == null) mà LLM vẫn đưa giá -> bỏ giá, null + warning.
 * - currency ưu tiên trang gốc, mặc định USD khi không có dữ liệu.
 * - images: chỉ URL http(s) CÓ TRONG DỮ LIỆU TRANG GỐC (source.images),
 *   tối đa 24 — LLM không được bịa URL ảnh; trống -> warning.
 * - description/material/dimensions: chuỗi hoặc null + warning khi trống
 *   (LLM được diễn đạt lại từ text trang, không kiểm tra chuỗi khớp).
 * - variants: giữ nguyên danh sách reader với options/SKU/UPC/ảnh/tiền
 *   tệ/tồn kho; AI không được đổi tổ hợp hay bỏ bớt SKU. Nếu reader không
 *   có variants, kiểm color/size của AI với text trang; tồn kho không
 *   xác minh được là null. Không có biến thể nào -> [] + warning.
 * Trả {extracted: {title, price, currency, images, description, material,
 * dimensions, variants}, warnings}.
 */
export function normalizeAiExtractedPage(raw, source = {}) {
  const warnings = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = source && typeof source === 'object' ? source : {};
  const sourceVariants = pageVariants(s);
  const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const title = truncateTitle(r.title ?? s.title ?? '', MAX_TITLE_LENGTH);
  if (!title) warnings.push('Trang không có tiêu đề — để trống, team tự điền');
  // Giá trang gốc: giá top-level (reader gửi — extension v1.3.2 đã sửa để
  // gửi, bản cũ gửi null) HOẶC giá 1 biến thể trên trang (vd Fleur: giá
  // 315 chỉ nằm ở biến thể, top-level null). Giá LLM chỉ nhận khi khớp 1
  // trong các giá này; trang không ghi giá mà LLM vẫn đưa giá là bịa.
  // v9.5 sửa lỗi cũ: trước đây chỉ nhìn giá top-level nên giá 315 của
  // Fleur bị bỏ với warning sai "Trang không ghi giá", và giá đúng LLM
  // trả cũng bị bỏ với lý do "LLM đưa giá nhưng trang không ghi giá".
  const sourcePrices = new Set(sourceVariants.map((sv) => cleanExtractPrice(sv.price)).filter((n) => n != null));
  const sourcePrice = cleanExtractPrice(s.price ?? null) ?? (sourcePrices.size ? Math.min(...sourcePrices) : null);
  let price = cleanExtractPrice(r.price ?? null) ?? sourcePrice;
  if (price == null) {
    warnings.push('Trang không ghi giá — để trống, team tự điền, không tự đoán giá');
  } else if (sourcePrice == null && r.price != null) {
    warnings.push('LLM đưa giá nhưng trang không ghi giá — bỏ giá, để trống');
    price = null;
  } else if (r.price != null && cleanExtractPrice(r.price) !== sourcePrice && !sourcePrices.has(cleanExtractPrice(r.price))) {
    warnings.push(`Giá LLM ${cleanExtractPrice(r.price)} không khớp giá trên trang gốc — dùng giá trang gốc ${sourcePrice}`);
    price = sourcePrice;
  }
  // Giá gốc gạch ngang (Regular Price) — compare-at: lấy từ source
  // top-level (extension v1.3.2 gửi compareAt), rồi từ pageText
  // ("Regular Price $450" trên trang Fleur). Giá riêng của một SKU không
  // được dùng làm compare-at cho SKU khác. Chỉ
  // áp dụng cho biến thể khi lớn hơn giá bán của biến thể đó; không có
  // thì thôi, không bịa.
  const sourceCompareAt = (() => {
    const fromTop = cleanExtractPrice(s.compareAt ?? null);
    if (fromTop != null) return fromTop;
    const m = String(s.pageText ?? '').match(/Regular Price\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
    const val = m ? Number(m[1].replace(/,/g, '')) : null;
    return val && val > 0 ? val : null;
  })();
  // The reader's currency belongs to the source price; AI cannot relabel GBP as USD.
  const sourceCurrency = cleanExtractString(s.currency, 3)
    ?? cleanExtractString(sourceVariants.find((v) => v.currency)?.currency, 3);
  const currency = (sourceCurrency ?? cleanExtractString(r.currency, 3) ?? 'USD').toUpperCase();
  if (sourceCurrency && r.currency && currency !== String(r.currency).trim().toUpperCase()) {
    warnings.push(`Tiền tệ AI không khớp trang gốc — giữ ${currency}, không tự quy đổi giá`);
  }
  // Ảnh: chỉ giữ URL có trong dữ liệu trang gốc (reader đã đọc). Trang
  // gốc không có ảnh mà LLM vẫn đưa URL ảnh là bịa — bỏ hết.
  const sourceImages = new Set(cleanExtractImages(s.images ?? []));
  const images = cleanExtractImages(r.images ?? s.images ?? []).filter((u) => sourceImages.has(u));
  if (!images.length) warnings.push('Trang không có ảnh sản phẩm — cần bổ sung ảnh trước khi xuất CSV');
  const descriptionText = r.description ?? s.description ?? s.description_text ?? null;
  const description = cleanExtractString(isSohoHomeSource(s) ? cleanSohoDescription(descriptionText) : descriptionText, 2000);
  if (!description) warnings.push('Trang không có mô tả — để trống, team tự điền');
  // Chất liệu: nhãn Material trong specs, rồi cụm chất liệu suy từ câu mô
  // tả (vd đèn Fleur không có nhãn Material riêng — chất liệu nằm trong
  // câu "Milky-white glass and lacquered sprayed metals are formed...").
  const material = cleanExtractString(r.material ?? s.specs?.Material ?? s.specs?.material ?? s.attributes?.material ?? null, 200)
    ?? materialPhraseFromDescription(description);
  if (!material) warnings.push('Trang không ghi chất liệu (Material) — để trống');
  const dimensions = cleanExtractString(r.dimensions ?? s.specs?.Dimensions ?? s.specs?.dimensions ?? s.attributes?.dimensions ?? null, 200);
  if (!dimensions) warnings.push('Trang không ghi kích thước (Dimensions) — để trống');
  // Màu/size của biến thể: phải có trên trang gốc (options của biến thể
  // reader hoặc text trang), không thì null + warning.
  const sourceOptions = new Set();
  for (const v of sourceVariants) {
    for (const val of Object.values(pageVariantOptions(v))) {
      const n = norm(val);
      if (n) sourceOptions.add(n);
    }
  }
  const pageTextNorm = norm(s.pageText ?? '');
  const onSourcePage = (value) => {
    const n = norm(value);
    if (!n) return false;
    if (sourceOptions.has(n)) return true;
    return pageTextNorm ? pageTextNorm.includes(n) : false;
  };
  const variants = [];
  // Source variants are authoritative. AI sees at most 20 in its prompt and
  // must never flatten a larger set, invent option combinations, or swap
  // prices/availability between SKUs.
  const fromReader = sourceVariants.length > 0;
  const rawVariants = fromReader ? sourceVariants : pageVariants(r);
  // Giá biến thể: chỉ nhận khi khớp 1 giá biến thể trên trang gốc hoặc
  // bằng giá sản phẩm; LLM tự đưa giá khác là bịa -> dùng giá sản phẩm.
  for (const v of rawVariants.slice(0, 250)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const options = pageVariantOptions(v);
    let color = cleanExtractString(v.color ?? Object.entries(options).find(([key]) => /^colou?r$/i.test(key))?.[1] ?? null, 100);
    let size = cleanExtractString(v.size ?? Object.entries(options).find(([key]) => /^size$/i.test(key))?.[1] ?? null, 100);
    if (color != null && !onSourcePage(color)) {
      warnings.push(`Màu "${color}" không có trên trang gốc — bỏ, để trống`);
      color = null;
    }
    if (size != null && !onSourcePage(size)) {
      warnings.push(`Size "${size}" không có trên trang gốc — bỏ, để trống`);
      size = null;
    }
    let vPrice = cleanExtractPrice(v.price ?? null);
    if (vPrice != null && !sourcePrices.has(vPrice) && vPrice !== sourcePrice) {
      warnings.push(`Giá biến thể ${vPrice} không có trên trang gốc — dùng giá sản phẩm`);
      vPrice = null;
    }
    const sameCurrency = String(v.currency ?? currency).toUpperCase() === String(currency).toUpperCase();
    vPrice = vPrice ?? (sameCurrency ? price : null);
    // Availability is factual reader data; AI-generated availability is not verified.
    const stock = fromReader ? pageVariantStock(v) : null;
    if (!fromReader && color == null && size == null && vPrice == null) {
      warnings.push('LLM trả 1 biến thể trống (không màu/size/giá) — bỏ qua biến thể đó');
      continue;
    }
    const variant = { color, size, price: vPrice, stock };
    if (fromReader) {
      // Keep the original option names, including a third or fourth dimension.
      variant.options = options;
      for (const field of ['sku', 'upc', 'currency']) {
        const value = cleanExtractString(v[field], 200);
        if (value != null) variant[field] = field === 'currency' ? value.toUpperCase() : value;
      }
      if (v.stock_qty != null && Number.isInteger(Number(v.stock_qty)) && Number(v.stock_qty) >= 0) {
        variant.stock_qty = Number(v.stock_qty);
      }
      const image = cleanExtractImages([v.image])[0];
      if (image) variant.image = image;
    }
    // Compare-at của biến thể: giá gốc riêng của nó, nếu không có thì
    // giá gốc chung của sản phẩm — chỉ khi lớn hơn giá bán. Không có
    // thì không thêm key (giữ nguyên shape {color,size,price,stock}
    // của các test cũ).
    const vCompareAt = fromReader ? cleanExtractPrice(v.compare_at_price ?? v.compareAt ?? null) : null;
    const effectiveCompareAt = (vCompareAt != null && vPrice != null && vCompareAt > vPrice)
      ? vCompareAt
      : (sourceCompareAt != null && vPrice != null && sourceCompareAt > vPrice ? sourceCompareAt : null);
    if (effectiveCompareAt != null) variant.compareAt = effectiveCompareAt;
    variants.push(variant);
  }
  if (!variants.length) warnings.push('Trang không liệt kê biến thể màu/size — sản phẩm coi như 1 biến thể duy nhất');
  // Specs đã có (reader + panel đào từ pageText, gồm Bulb type / Care
  // instructions của đèn) được giữ lại trong extracted để extractPageRecord
  // ghi vào sản phẩm — CSV và danh sách "Đã cào được" dùng được ngay.
  const mergedSpecs = {
    ...(s.specs && typeof s.specs === 'object' ? s.specs : {}),
    ...(material ? { Material: material } : {}),
    ...(dimensions ? { Dimensions: dimensions } : {}),
  };
  return {
    extracted: { title: title || null, price, currency, images, description, material, dimensions, variants, specs: mergedSpecs },
    warnings,
  };
}

/**
 * Trích xuất theo luật từ dữ liệu trang đã đọc (fallback khi không có key
 * AI hoặc LLM lỗi): lấy thẳng title/giá/ảnh/mô tả/biến thể của reader.
 * Size/màu lấy từ options của biến thể reader (trang gốc) — không bịa.
 * v9.5: trước khi trích xuất, đào panel "Details & Dimensions" từ pageText
 * (enrichRawWithPageDetails) để lấp mô tả/specs mà reader bỏ lỡ (vd panel
 * accordion đóng lúc extension đọc) — vẫn KHÔNG cần key AI.
 * Trả {extracted, warnings} cùng shape với normalizeAiExtractedPage.
 */
export function ruleBasedExtractPage(raw) {
  const r = enrichRawWithPageDetails(raw);
  const normalized = normalizeAiExtractedPage({
    title: r.title ?? null,
    price: r.price ?? null,
    currency: r.currency ?? null,
    images: r.images ?? [],
    description: r.description ?? r.description_text ?? null,
    material: r.specs?.Material ?? r.specs?.material ?? r.attributes?.material ?? null,
    dimensions: r.specs?.Dimensions ?? r.specs?.dimensions ?? r.attributes?.dimensions ?? null,
    variants: pageVariants(r),
  }, r);
  return normalized;
}

/**
 * Trích xuất 1 trang qua AiRuntime: có key thì gọi LLM thật, không có key
 * thì trích xuất theo luật từ dữ liệu trang đã đọc. LLM lỗi / timeout /
 * trả JSON hỏng -> fallback theo luật kèm warning rõ lý do, KHÔNG crash.
 * Gặp 429 -> fallback theo luật + cờ rateLimited để client dừng bulk.
 * Trả {extracted, warnings, provider, rateLimited}.
 */
export async function extractPageWithRuntime(raw, runtime) {
  // Đào panel Details từ pageText TRƯỚC khi trích xuất (cả đường LLM lẫn
  // đường luật) để mô tả/specs không phụ thuộc vào việc reader có đọc
  // được panel accordion hay không.
  const enriched = enrichRawWithPageDetails(raw);
  const fallback = (extraWarnings, provider = 'rule-based', rateLimited = false) => {
    const base = ruleBasedExtractPage(enriched);
    return { extracted: base.extracted, warnings: [...base.warnings, ...extraWarnings], provider, rateLimited };
  };
  if (!runtime || typeof runtime.callLlmJson !== 'function' || !runtime.getStatus?.().configured) {
    return fallback(['Chưa có key AI — trích xuất theo luật từ dữ liệu trang đã đọc. Dán key Gemini/OpenAI vào tab AI gợi ý để AI trích xuất.']);
  }
  try {
    const prompt = buildAiExtractPagePrompt(enriched);
    const llmRaw = await runtime.callLlmJson(prompt.system, prompt.user);
    const { extracted, warnings } = normalizeAiExtractedPage(llmRaw, enriched);
    const cfg = runtime.getStatus?.() ?? {};
    return { extracted, warnings, provider: cfg.provider ?? 'llm', rateLimited: false };
  } catch (e) {
    if (isRateLimitError(e)) {
      return fallback(['AI trích xuất chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại; nếu vẫn lỗi, kiểm tra quota của model/project tại nhà cung cấp. Trang này đã dùng dữ liệu đọc theo luật.'], 'rule-based', true);
    }
    const reason = e?.message ? String(e.message) : 'lỗi không rõ';
    return fallback([`AI trích xuất lỗi (${reason}) — dùng dữ liệu đọc theo luật`]);
  }
}

/**
 * Trích xuất hàng loạt nhiều trang (tối đa 20), gọi LLM tuần tự.
 * Gặp 429 thì DỪNG gọi LLM: các trang còn lại dùng trích xuất theo luật,
 * cờ stopped429 để giao diện báo đợi 1 phút rồi thử lại.
 * Trả {results: [{extracted, warnings, provider, rateLimited}], stopped429, provider}.
 */
export async function extractPagesWithRuntime(pages, runtime) {
  const list = (pages ?? []).slice(0, AI_EXTRACT_PAGES_MAX);
  const results = [];
  let stopped429 = false;
  let usedLlm = false;
  for (const raw of list) {
    if (stopped429) {
      const base = ruleBasedExtractPage(raw);
      results.push({ extracted: base.extracted, warnings: [...base.warnings, 'Đã dừng gọi AI do chạm giới hạn (429) — trang này dùng dữ liệu đọc theo luật.'], provider: 'rule-based', rateLimited: false });
      continue;
    }
    const result = await extractPageWithRuntime(raw, runtime);
    if (result.rateLimited) stopped429 = true;
    if (result.provider !== 'rule-based') usedLlm = true;
    results.push(result);
  }
  const provider = usedLlm ? (runtime?.getStatus?.().provider ?? 'llm') : 'rule-based';
  return { results, stopped429, provider };
}

/**
 * Dựng record crawl (đúng shape normalizeRecord) từ dữ liệu trang gốc +
 * kết quả AI trích xuất. Size/màu lấy từ extracted.variants (đã lấy từ
 * trang gốc); giá lấy extracted.price (non-member); title cắt ≤80.
 */
export function extractPageRecord(raw, extracted) {
  const r = raw ?? {};
  const e = extracted ?? {};
  const variants = pageVariants(e).map((v) => {
    const options = pageVariantOptions(v);
    return {
      options,
      price: v.price ?? (String(v.currency ?? e.currency ?? r.currency).toUpperCase() === String(e.currency ?? r.currency).toUpperCase() ? e.price : null) ?? null,
      compare_at_price: v.compare_at_price ?? v.compareAt ?? r.compareAt ?? null,
      in_stock: pageVariantStock(v),
      sku: v.sku ?? null,
      upc: v.upc ?? null,
      currency: v.currency ?? e.currency ?? r.currency ?? null,
      stock_qty: v.stock_qty ?? null,
      image: v.image ?? null,
    };
  });
  // Giá sản phẩm: giá đã trích xuất, rồi giá top-level reader, rồi giá
  // biến thể rẻ nhất còn giá — KHÔNG để mất giá chỉ vì top-level null
  // (extension bản cũ không gửi price ở cấp record).
  const variantPrices = [...pageVariants(e), ...pageVariants(r)]
    .map((v) => cleanExtractPrice(v?.price ?? null)).filter((n) => n != null);
  return {
    source_site: r.sourceSite ?? r.source_site ?? null,
    source_product_id: r.sourceProductId ?? r.source_product_id ?? null,
    source_url: r.url ?? r.source_url ?? null,
    brand: r.brand ?? null,
    title: e.title ?? r.title ?? null,
    description_text: e.description ?? r.description ?? r.description_text ?? null,
    images: e.images ?? r.images ?? [],
    currency: e.currency ?? r.currency ?? 'USD',
    price: e.price ?? r.price ?? (variantPrices.length ? Math.min(...variantPrices) : null),
    in_stock: pageVariantStock(r),
    variants,
    options: Array.isArray(r.option_names) ? r.option_names : (Array.isArray(r.options) ? r.options : []),
    flags: { ...(r.flags ?? {}) },
    crawl_truncated: Boolean(r.crawl_truncated ?? r.truncated) || pageVariants(r).length > 250,
    // Specs: reader thắng khi trùng nhãn; specs đã trích xuất (gồm
    // Material/Dimensions suy ra + Bulb type / Care instructions đào từ
    // panel) được giữ lại để xuất CSV và hiện "Đã cào được".
    specs: {
      ...(r.specs ?? {}),
      ...(e.specs ?? {}),
      ...(e.material ? { Material: e.material } : {}),
      ...(e.dimensions ? { Dimensions: e.dimensions } : {}),
    },
    attributes: r.attributes ?? {},
  };
}

// ---- Gom nhóm sản phẩm giống nhau bằng AI (v6) ------------------------------
// Phân nhóm theo từ khoá (groupProductsByTheme) sai/thiếu với tên không chứa
// từ khoá loại (vd "Soho Home Dax", "Mayfair"): LLM đọc tên + mô tả + specs
// rồi gom các sản phẩm GIỐNG NHAU / cùng loại vào chung 1 nhóm, mỗi nhóm
// xuất 1 file CSV riêng. Không có key AI hoặc LLM lỗi -> fallback về nhóm
// theo từ khoá, kèm cờ provider: 'rule-based' để giao diện hiển thị rõ.

/** Số sản phẩm tối đa trong 1 lần gọi LLM khi gom nhóm (giới hạn token). */
export const AI_GROUP_BATCH_SIZE = 20;
/** Mô tả gửi LLM khi gom nhóm: text thuần, tối đa 300 ký tự/sản phẩm. */
export const AI_GROUP_MAX_DESCRIPTION_CHARS = 300;
/** Nhóm dành cho sản phẩm LLM không gán được nhóm nào — không tự đoán thay. */
export const UNCLASSIFIED_GROUP_KEY = 'chua-phan-loai';
export const UNCLASSIFIED_GROUP_LABEL = 'Chưa phân loại';

/**
 * Chuẩn hoá groupKey do LLM trả về thành slug tiếng Anh không dấu.
 * Các biến thể gối (throw-pillows, square-cushions, pillow-covers...)
 * gộp về 'cushions' để cùng xuất 1 file CSV theo template 20563 —
 * chia nhỏ hơn nữa không có ý nghĩa vì cùng 1 template/category.
 */
export function canonicalGroupKey(rawKey) {
  const key = slugifyTheme(rawKey);
  if (!key) return '';
  if (/(cushion|pillow|bolster|sham)/.test(key)) return 'cushions';
  return key;
}

/** Nhãn hiển thị mặc định cho một groupKey (khi LLM không gửi groupLabel). */
export function defaultGroupLabel(groupKey) {
  if (groupKey === UNCLASSIFIED_GROUP_KEY) return UNCLASSIFIED_GROUP_LABEL;
  if (groupKey === 'cushions') return 'Cushions & Pillows';
  return groupKey.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** categoryId eBay của một nhóm: hiện chỉ nhóm gối có template (20563). */
export function groupCategoryId(groupKey) {
  return groupKey === 'cushions' ? '20563' : null;
}

function productGroupInput(p) {
  const desc = stripHtmlToText(p.description ?? p.description_text ?? '', AI_GROUP_MAX_DESCRIPTION_CHARS);
  const specs = p.specs ?? {};
  const material = specs.Material ?? specs.material ?? p.attributes?.Material ?? null;
  const size = specs.Size ?? specs.size ?? specs.Dimensions ?? p.attributes?.Size ?? null;
  return {
    id: p.id,
    title: p.edits?.title ?? p.title ?? p.title_raw ?? '',
    description: desc || null,
    material: material != null ? String(material) : null,
    size: size != null ? String(size) : null,
    theme: p.theme ?? p.product_type ?? null,
  };
}

/**
 * Prompt gom nhóm: gửi tối đa 1 batch sản phẩm, yêu cầu LLM trả JSON duy
 * nhất là MẢNG [{productId, groupKey, groupLabel, ebayType}]. Gom các sản
 * phẩm GIỐNG NHAU / cùng loại vào chung 1 nhóm; mỗi sản phẩm đúng 1 nhóm.
 * ebayType chỉ trong 22 giá trị cho phép của template 20563 (khi nhóm đó
 * là gối), không phải gối thì null — tuyệt đối không bịa giá trị khác.
 */
export function buildAiGroupPrompt(products) {
  const list = (products ?? []).map(productGroupInput);
  const system = [
    'Bạn là trợ lý phân loại sản phẩm để đăng bán trên eBay US.',
    'Gom các sản phẩm GIỐNG NHAU / cùng loại vào chung 1 nhóm (ví dụ: tất cả gối vuông vào 1 nhóm, đèn bàn vào 1 nhóm, gương treo tường vào 1 nhóm, đồ phòng tắm bằng đồng vào 1 nhóm).',
    'Chỉ trả về MỘT mảng JSON duy nhất, không giải thích, không markdown ngoài JSON:',
    '[{"productId": "...", "groupKey": "cushions", "groupLabel": "Cushions & Pillows", "ebayType": "Throw Pillow" hoặc null}]',
    'Mỗi sản phẩm trong danh sách PHẢI xuất hiện đúng 1 lần, productId giữ y hệt như đã gửi.',
    'groupKey: slug tiếng Anh không dấu, ngắn gọn (nên dùng các khoá sau khi khớp: cushions, rugs, table-lamps, wall-lights, wall-mirrors, bathroom, seating, tables, beds, storage, decor, kitchen, textiles; chỉ bịa khoá mới khi không có khoá nào khớp).',
    'groupLabel: tên nhóm ngắn gọn để hiển thị (tiếng Anh, vd "Table Lamps").',
    `ebayType: CHỈ khi sản phẩm thuộc nhóm gối, đúng 1 trong 22 giá trị sau (hoặc null khi không chắc, tuyệt đối không bịa giá trị khác): ${EBAY_TYPES_20563.join('; ')}. Nhóm không phải gối thì ebayType = null.`,
    'Chỉ suy ra từ tên + mô tả + chất liệu/kích thước dưới đây; thông tin nào không có thì vẫn gom theo tên/mô tả, không bịa.',
  ].join('\n');
  const user = JSON.stringify(list, null, 0);
  return { system, user };
}

/**
 * Kiểm chứng kết quả gom nhóm thô từ LLM:
 * - mỗi sản phẩm đúng 1 nhóm; productId lạ -> warning + bỏ qua dòng đó.
 * - sản phẩm thiếu trong kết quả / groupKey rỗng -> nhóm "chua-phan-loai"
 *   + warning, KHÔNG tự đoán thay, KHÔNG bỏ sản phẩm im lặng.
 * - ebayType: chỉ nhận đúng 1 trong 22 giá trị cho phép, ngoài danh sách
 *   -> null + warning. Nhóm không phải gối -> ebayType null.
 * Trả {assignments: [{productId, groupKey, groupLabel, ebayType}], warnings,
 * unclassified: [productId]}.
 */
export function normalizeAiGroupAssignments(raw, products) {
  const warnings = [];
  const list = products ?? [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const assignments = [];
  const seen = new Set();
  if (!Array.isArray(raw)) {
    throw new Error('LLM không trả về mảng JSON khi gom nhóm');
  }
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('LLM trả một dòng gom nhóm không phải object — bỏ qua dòng đó');
      continue;
    }
    const productId = item.productId ?? item.id ?? null;
    if (productId == null || !byId.has(productId)) {
      warnings.push(`LLM gom nhóm productId lạ "${String(productId ?? '')}" — bỏ qua dòng đó`);
      continue;
    }
    if (seen.has(productId)) {
      warnings.push(`LLM gán sản phẩm "${productId}" vào 2 nhóm — chỉ giữ lần gán đầu`);
      continue;
    }
    seen.add(productId);
    const groupKey = canonicalGroupKey(item.groupKey);
    if (!groupKey) {
      warnings.push(`LLM không gán được nhóm cho "${byId.get(productId).title ?? productId}" — đưa vào nhóm Chưa phân loại`);
      assignments.push({ productId, groupKey: UNCLASSIFIED_GROUP_KEY, groupLabel: UNCLASSIFIED_GROUP_LABEL, ebayType: null });
      continue;
    }
    let ebayType = null;
    const rawType = item.ebayType ?? item.type ?? null;
    if (rawType != null && String(rawType).trim() !== '') {
      if (groupKey !== 'cushions') {
        warnings.push(`Nhóm "${groupKey}" không phải gối nên không cần Type — bỏ ebayType LLM gợi ý`);
      } else {
        const match = EBAY_TYPES_20563.find((v) => v.toLowerCase() === String(rawType).trim().toLowerCase());
        if (match) ebayType = match;
        else warnings.push(`AI gợi ý Type "${String(rawType).trim()}" ngoài danh sách cho phép — để trống, team tự điền`);
      }
    }
    assignments.push({
      productId,
      groupKey,
      groupLabel: (typeof item.groupLabel === 'string' && item.groupLabel.trim())
        ? item.groupLabel.trim()
        : defaultGroupLabel(groupKey),
      ebayType,
    });
  }
  const unclassified = [];
  for (const p of list) {
    if (!seen.has(p.id)) {
      assignments.push({ productId: p.id, groupKey: UNCLASSIFIED_GROUP_KEY, groupLabel: UNCLASSIFIED_GROUP_LABEL, ebayType: null });
    }
  }
  // unclassified = mọi sản phẩm đang ở nhóm Chưa phân loại, gồm cả sản phẩm
  // LLM trả groupKey rỗng lẫn sản phẩm LLM không nhắc tới.
  for (const a of assignments) {
    if (a.groupKey === UNCLASSIFIED_GROUP_KEY) unclassified.push(a.productId);
  }
  if (unclassified.length) {
    warnings.push(`${unclassified.length} sản phẩm LLM không gán nhóm — đưa vào nhóm Chưa phân loại, team kiểm lại tay`);
  }
  return { assignments, warnings, unclassified };
}

/**
 * Gom nhóm theo từ khoá (fallback khi không có key AI hoặc LLM lỗi):
 * dùng groupProductsByTheme có sẵn; nhóm gối lấy ebayType bằng mapEbayType
 * (khớp trong 22 giá trị cho phép, không khớp thì null), nhóm khác null.
 */
export function ruleBasedGroupAssignments(products) {
  const fakeTemplate = { recommendedValues: { Type: EBAY_TYPES_20563 } };
  const assignments = [];
  for (const g of groupProductsByTheme(products ?? [])) {
    for (const p of g.products) {
      assignments.push({
        productId: p.id,
        groupKey: g.key,
        groupLabel: g.label,
        ebayType: g.key === 'cushions' ? (mapEbayType(p, fakeTemplate) || null) : null,
      });
    }
  }
  return { assignments, warnings: [], unclassified: [] };
}

/** Tóm tắt các nhóm từ assignments: [{key, label, categoryId, productIds, sampleTitles}]. */
export function summarizeGroups(assignments, products) {
  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  const byKey = new Map();
  for (const a of assignments ?? []) {
    let g = byKey.get(a.groupKey);
    if (!g) {
      g = { key: a.groupKey, label: a.groupLabel, categoryId: groupCategoryId(a.groupKey), productIds: [], sampleTitles: [] };
      byKey.set(a.groupKey, g);
    }
    g.productIds.push(a.productId);
    const title = byId.get(a.productId)?.title ?? a.productId;
    if (g.sampleTitles.length < 3) g.sampleTitles.push(title);
  }
  return [...byKey.values()].map((g) => ({ ...g, count: g.productIds.length }));
}

/**
 * Gom nhóm nhiều sản phẩm bằng LLM, chia batch tối đa 20 sản phẩm/lần gọi,
 * gọi tuần tự (giữ giãn cách của runtime cho gói miễn phí Gemini).
 * @param {Array} products - sản phẩm đã chuẩn hoá (có id).
 * @param {function} callLlmJson - fn async (system, user) => object JSON đã
 *   parse (vd runtime.callLlmJson); null/undefined -> fallback theo luật.
 * @param {object} [opts] - { timeoutMs }.
 * @returns {Promise<{assignments, groups, unclassified, warnings, provider, stopped429}>}
 *   provider: 'llm' khi gọi LLM thật (theo opts.providerName), 'rule-based'
 *   khi không có key hoặc LLM lỗi và đã fallback. stopped429: true khi gặp
 *   429 giữa chừng — đã dừng gọi LLM, các batch còn lại dùng nhóm theo luật.
 */
export async function groupProductsWithAi(products, callLlmJson, opts = {}) {
  const list = (products ?? []).filter((p) => p && p.id != null);
  if (!list.length) return { assignments: [], groups: [], unclassified: [], warnings: ['Không có sản phẩm nào để phân loại.'], provider: 'rule-based', stopped429: false };
  const providerName = opts.providerName ?? 'llm';
  if (typeof callLlmJson !== 'function') {
    const base = ruleBasedGroupAssignments(list);
    return {
      assignments: base.assignments,
      groups: summarizeGroups(base.assignments, list),
      unclassified: base.unclassified,
      warnings: ['Chưa có key AI — đang phân loại theo từ khoá trong tên. Dán key Gemini/OpenAI vào tab AI gợi ý để AI phân loại.'],
      provider: 'rule-based',
      stopped429: false,
    };
  }
  const assignments = [];
  const warnings = [];
  let stopped429 = false;
  let usedLlm = false;
  for (let i = 0; i < list.length; i += AI_GROUP_BATCH_SIZE) {
    const batch = list.slice(i, i + AI_GROUP_BATCH_SIZE);
    if (stopped429) {
      const base = ruleBasedGroupAssignments(batch);
      assignments.push(...base.assignments);
      continue;
    }
    try {
      const prompt = buildAiGroupPrompt(batch);
      const raw = await callLlmJson(prompt.system, prompt.user, { timeoutMs: opts.timeoutMs, jsonKind: 'array' });
      const { assignments: batchAssignments, warnings: batchWarnings, unclassified } = normalizeAiGroupAssignments(raw, batch);
      assignments.push(...batchAssignments);
      warnings.push(...batchWarnings);
      usedLlm = true;
      void unclassified;
    } catch (e) {
      if (isRateLimitError(e)) {
        stopped429 = true;
        warnings.push('AI chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại; nếu vẫn lỗi, kiểm tra quota của model/project tại nhà cung cấp. Các sản phẩm còn lại đã dùng nhóm theo từ khoá, không mất dữ liệu.');
        const base = ruleBasedGroupAssignments(batch);
        assignments.push(...base.assignments);
      } else {
        const reason = e?.message ? String(e.message) : 'lỗi không rõ';
        warnings.push(`AI gom nhóm lỗi ở batch ${Math.floor(i / AI_GROUP_BATCH_SIZE) + 1} (${reason}) — batch này dùng nhóm theo từ khoá`);
        const base = ruleBasedGroupAssignments(batch);
        assignments.push(...base.assignments);
      }
    }
  }
  const unclassified = assignments.filter((a) => a.groupKey === UNCLASSIFIED_GROUP_KEY).map((a) => a.productId);
  return {
    assignments,
    groups: summarizeGroups(assignments, list),
    unclassified,
    warnings,
    provider: usedLlm ? providerName : 'rule-based',
    stopped429,
  };
}

/**
 * Gom nhóm qua AiRuntime: có key thì gọi LLM thật, không có key thì nhóm
 * theo từ khoá. Trả thêm cờ provider để giao diện hiển thị rõ nguồn nhóm.
 */
export async function groupWithRuntime(products, runtime, opts = {}) {
  if (!runtime || typeof runtime.callLlmJson !== 'function') {
    return groupProductsWithAi(products, null, opts);
  }
  const cfg = runtime.getStatus?.() ?? {};
  if (!cfg.configured) return groupProductsWithAi(products, null, opts);
  return groupProductsWithAi(products, (system, user, callOpts) => runtime.callLlmJson(system, user, callOpts), {
    ...opts,
    providerName: cfg.provider ?? 'llm',
  });
}

// ---- AI gợi ý danh mục eBay cho file nháp (v7) -----------------------------
// User không thể đưa hết template từng danh mục: file nháp dùng template
// gối làm mẫu cột nên cột Category vẫn trống. LLM chỉ GỢI Ý tên danh mục
// eBay có thể đúng + các trường riêng danh mục đó thường cần — ở dạng text
// "AI đoán, chưa xác minh", HIỂN THỊ cho team kiểm chứng ở Seller Hub,
// KHÔNG BAO GIỜ ghi vào cột Category hay C:Type của file nháp.
// Không có key AI thì bỏ qua phần này, file nháp vẫn tạo được từ dữ liệu
// sheet/trang (chỉ thiếu gợi ý danh mục).

/** Số nhóm tối đa gửi LLM gợi ý danh mục trong 1 lần gọi. */
export const AI_DRAFT_CATEGORY_MAX_GROUPS = 20;
/** Số trường riêng tối đa LLM gợi ý cho 1 danh mục. */
export const AI_DRAFT_CATEGORY_MAX_ASPECTS = 10;

function draftCategoryGroupInput(g) {
  return {
    groupKey: g.key ?? g.groupKey,
    groupLabel: g.label ?? g.groupLabel ?? g.key ?? g.groupKey,
    count: g.count ?? (Array.isArray(g.productIds) ? g.productIds.length : null),
    sampleTitles: Array.isArray(g.sampleTitles) ? g.sampleTitles.slice(0, 3) : [],
  };
}

/**
 * Prompt gợi ý danh mục: gửi danh sách nhóm (tên nhóm + vài tên mẫu),
 * yêu cầu LLM trả JSON duy nhất là MẢNG
 * [{groupKey, suggestedCategory, suggestedAspects: [...], note}].
 * suggestedCategory = tên danh mục eBay (tiếng Anh, vd "Table Lamps");
 * suggestedAspects = các trường riêng danh mục đó thường cần trên eBay
 * (vd đèn: "Bulb Type", "Wattage", "Shade Material"). Đây là PHỎNG ĐOÁN
 * để team kiểm chứng ở Seller Hub — không phải CategoryId đã xác minh.
 */
export function buildAiDraftCategoryPrompt(groups) {
  const list = (groups ?? []).map(draftCategoryGroupInput);
  const system = [
    'Bạn là trợ lý phân loại sản phẩm để đăng bán trên eBay US.',
    'Với mỗi nhóm sản phẩm dưới đây, hãy PHỎNG ĐOÁN tên danh mục eBay (tiếng Anh) có khả năng đúng nhất và các trường riêng (item specifics) mà danh mục đó thường yêu cầu.',
    'Chỉ trả về MỘT mảng JSON duy nhất, không giải thích, không markdown ngoài JSON:',
    '[{"groupKey": "table-lamps", "suggestedCategory": "Table Lamps", "suggestedAspects": ["Bulb Type", "Wattage", "Shade Material"], "note": "kiểm chứng ở Seller Hub"}]',
    'Mỗi nhóm PHẢI xuất hiện đúng 1 lần, groupKey giữ y hệt như đã gửi.',
    'suggestedCategory: tên danh mục eBay, không ghi mã số (không bịa CategoryId). Không chắc thì ghi tên gần nhất và nói rõ trong note.',
    'suggestedAspects: tối đa 10 trường, chỉ tên trường (vd "Bulb Type"), không bịa giá trị cụ thể cho từng sản phẩm.',
    'Đây là gợi ý chưa xác minh — người dùng sẽ kiểm chứng tên danh mục ở Seller Hub trước khi dùng.',
  ].join('\n');
  const user = JSON.stringify(list, null, 0);
  return { system, user };
}

/**
 * Kiểm chứng gợi ý danh mục thô từ LLM:
 * - groupKey phải khớp 1 nhóm đã gửi (chuẩn hoá slug), lạ -> bỏ + warning.
 * - suggestedCategory rỗng -> bỏ + warning. suggestedAspects chỉ giữ chuỗi
 *   không rỗng, tối đa 10, bỏ trùng.
 * Trả {suggestions: [{groupKey, suggestedCategory, suggestedAspects,
 * note}], warnings}. Gợi ý này chỉ để hiển thị — không ghi vào CSV.
 */
export function normalizeDraftCategorySuggestions(raw, groups) {
  const warnings = [];
  const known = new Map((groups ?? []).map((g) => [slugifyTheme(g.key ?? g.groupKey), g]));
  if (!Array.isArray(raw)) {
    throw new Error('LLM không trả về mảng JSON khi gợi ý danh mục');
  }
  const suggestions = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('LLM trả một dòng gợi ý danh mục không phải object — bỏ qua dòng đó');
      continue;
    }
    const groupKey = slugifyTheme(item.groupKey);
    if (!groupKey || !known.has(groupKey)) {
      warnings.push(`LLM gợi ý danh mục cho nhóm lạ "${String(item.groupKey ?? '')}" — bỏ qua dòng đó`);
      continue;
    }
    if (seen.has(groupKey)) {
      warnings.push(`LLM gợi ý danh mục cho nhóm "${groupKey}" 2 lần — chỉ giữ lần đầu`);
      continue;
    }
    seen.add(groupKey);
    const category = String(item.suggestedCategory ?? '').trim();
    if (!category) {
      warnings.push(`LLM không gợi ý được tên danh mục cho nhóm "${groupKey}" — để trống, team tự tra ở Seller Hub`);
      continue;
    }
    const aspects = [...new Set(
      (Array.isArray(item.suggestedAspects) ? item.suggestedAspects : [])
        .map((a) => String(a ?? '').trim()).filter(Boolean),
    )].slice(0, AI_DRAFT_CATEGORY_MAX_ASPECTS);
    suggestions.push({
      groupKey,
      suggestedCategory: category.slice(0, 120),
      suggestedAspects: aspects,
      note: typeof item.note === 'string' && item.note.trim() ? item.note.trim().slice(0, 200) : null,
    });
  }
  return { suggestions, warnings };
}

/**
 * Gợi ý danh mục cho các nhóm chưa có template qua AiRuntime (1 lần gọi
 * cho tối đa 20 nhóm). Nhóm gối (đã có template) và nhóm chưa phân loại
 * không cần gợi ý nên tự bỏ qua. Không có key / LLM lỗi / 429 -> gợi ý
 * rỗng kèm warning, KHÔNG throw — file nháp vẫn tạo được, chỉ thiếu gợi ý.
 * Trả {suggestions, warnings, provider}.
 */
export async function suggestDraftCategoriesWithRuntime(groups, runtime) {
  const list = (groups ?? [])
    .map(draftCategoryGroupInput)
    .filter((g) => g.groupKey && g.groupKey !== 'cushions' && g.groupKey !== UNCLASSIFIED_GROUP_KEY)
    .slice(0, AI_DRAFT_CATEGORY_MAX_GROUPS);
  if (!list.length) return { suggestions: [], warnings: [], provider: 'rule-based' };
  if (!runtime || typeof runtime.callLlmJson !== 'function' || !runtime.getStatus?.().configured) {
    return {
      suggestions: [],
      warnings: ['Chưa có key AI — file nháp vẫn tạo được từ dữ liệu sheet/trang, chỉ thiếu gợi ý tên danh mục eBay. Dán key Gemini/OpenAI vào tab AI gợi ý để AI gợi ý.'],
      provider: 'rule-based',
    };
  }
  try {
    const prompt = buildAiDraftCategoryPrompt(list);
    const raw = await runtime.callLlmJson(prompt.system, prompt.user, { jsonKind: 'array' });
    const { suggestions, warnings } = normalizeDraftCategorySuggestions(raw, list);
    const cfg = runtime.getStatus?.() ?? {};
    return { suggestions, warnings, provider: cfg.provider ?? 'llm' };
  } catch (e) {
    if (isRateLimitError(e)) {
      return {
        suggestions: [],
        warnings: ['AI gợi ý danh mục chạm giới hạn request (HTTP 429) — đợi 1 phút rồi bấm lại. File nháp vẫn tạo được, chỉ thiếu gợi ý danh mục.'],
        provider: 'rule-based',
      };
    }
    const reason = e?.message ? String(e.message) : 'lỗi không rõ';
    return {
      suggestions: [],
      warnings: [`AI gợi ý danh mục lỗi (${reason}) — file nháp vẫn tạo được, chỉ thiếu gợi ý danh mục.`],
      provider: 'rule-based',
    };
  }
}

export default { validateAiSuggestion, suggestFromProduct, suggestWithRuntime, groupProductsWithAi, groupWithRuntime, suggestDraftCategoriesWithRuntime, buildAiExtractPagePrompt, normalizeAiExtractedPage, ruleBasedExtractPage, extractPageWithRuntime, extractPagesWithRuntime, extractPageRecord, parseSohoDetailsText, materialPhraseFromDescription, enrichRawWithPageDetails, SOHO_DETAIL_LABELS };
