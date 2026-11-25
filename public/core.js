// public/core.js — Luật nghiệp vụ dùng chung cho trình duyệt và server.
// Sửa luật thì sửa một chỗ này, thêm test vào tests/.
// Không đăng lên eBay, chỉ chuẩn hoá dữ liệu và tạo CSV để upload lên Seller Hub.
// ESM cho Node/Workers; trong trình duyệt được expose qua window.CsvEbayCore
// (xem cuối file).

export const MAX_VARIANTS = 250;
export const MAX_TITLE_LENGTH = 80;
export const MAX_IMAGES = 24;

/**
 * 22 giá trị Type cho phép của template eBay category 20563 (gối/cushion).
 * Copy y hệt từ template thật public/templates/ebay-20563.csv
 * (recommendedValues.Type) — test trong tests/ai-providers.test.mjs kiểm tra
 * hằng này khớp 100% với template, để không hardcode sai lệch. AI chỉ được
 * gợi ý đúng 1 trong 22 giá trị này (hoặc null khi không chắc).
 */
export const EBAY_TYPES_20563 = [
  'Back Cushion', 'Bench Cushion', 'Bolster', 'Bolster Cover', 'Box Cushion',
  'Chair Cushion', 'Cushion', 'Cushion Pad', 'Decorative Pillow', 'Floor Cushion',
  'Foam Cushion', 'Lumbar Pillow', 'Needlepoint Pillow', 'Pillow Cover',
  'Pillow Insert', 'Plush Pillow', 'Posture Cushion', 'Seat Cushion',
  'Sofa Cushion', 'Throw Pillow', 'Travel Pillow', 'Window Seat Cushion',
];

/**
 * Các khía cạnh (item specifics) mà AI được phép gợi ý — đúng các cột C:
 * có trong template 20563. Type và Brand không nằm đây: Type đi riêng
 * (ebayType, kiểm chứng theo EBAY_TYPES_20563), Brand luôn lấy từ
 * sản phẩm/sheet, AI không được tự bịa Brand.
 */
export const AI_SPECIFIC_ASPECTS = [
  'Theme', 'Style', 'Color', 'Pattern', 'Material', 'Size', 'Shape',
  'Features', 'Subject', 'Room', 'Department', 'Country of Origin',
  'Fill Material', 'Closure Type', 'Care Instructions', 'Product Line',
  'Model', 'Item Height', 'Item Width', 'Item Length', 'Item Weight',
];
export const EBAY_FEE_PCT_DEFAULT = 0.13;

/** Khoảng giá hợp lý (USD) theo site — ngoài khoảng thì cảnh báo, không chặn. */
export const SITE_RANGES = {
  'ogl-move': [20, 500],
  azazie: [20, 600],
  prana: [20, 400],
  'eileen-fisher': [30, 800],
  // Soho Home: giá nguồn thật cao (bàn $1,470, thảm $2,450, có trang $12,995).
  // Sheet Sabo_Lucky_Rate 9 ghi MIN-MAX 100$-1000$ là TIÊU CHÍ LỌC giá nguồn
  // khi chọn sản phẩm đưa vào sheet, KHÔNG phải khoảng giá hợp lệ của site.
  // Range dưới đây chỉ để cảnh báo, không chặn import.
  'soho-home': [100, 5000],
  amazon: [5, 2000],
  walmart: [5, 2000],
  ebay: [5, 5000],
  aliexpress: [3, 500],
};

export const WOMEN_ONLY_SITES = ['azazie', 'eileen-fisher'];

/** Từ khoá -> danh mục gợi ý. Thêm từ khoá mới kèm test. */
export const CATEGORY_KEYWORDS = [
  { keywords: ['dress', 'gown', 'váy'], category: "Women's Dresses" },
  { keywords: ['top', 'blouse', 'shirt', 'áo'], category: "Women's Tops & Blouses" },
  { keywords: ['pants', 'trousers', 'quần'], category: "Women's Pants" },
  { keywords: ['skirt', 'chân váy'], category: "Women's Skirts" },
  { keywords: ['jacket', 'coat', 'blazer'], category: "Women's Coats & Jackets" },
  { keywords: ['sweater', 'knit', 'cardigan'], category: "Women's Sweaters" },
  { keywords: ['swim', 'bikini', 'swimsuit'], category: "Women's Swimwear" },
  { keywords: ['shoe', 'sneaker', 'boot', 'giày'], category: "Women's Shoes" },
  { keywords: ['bag', 'handbag', 'túi'], category: "Women's Bags & Handbags" },
  { keywords: ['legging', 'yoga'], category: "Women's Activewear" },
  { keywords: ['shorts'], category: "Women's Shorts" },
  // Đồ gia dụng / nội thất (Soho Home...). Đặt sau nhóm thời trang.
  { keywords: ['cushion', 'pillow', 'bolster', 'sham'], category: 'Cushions & Pillows' },
  { keywords: ['rug', 'carpet'], category: 'Rugs' },
  { keywords: ['lamp', 'chandelier', 'sconce', 'pendant', 'light'], category: 'Lamps & Lighting' },
  { keywords: ['mirror'], category: 'Mirrors' },
  { keywords: ['sofa', 'armchair', 'chaise'], category: 'Sofas & Armchairs' },
  { keywords: ['table', 'desk'], category: 'Tables' },
  { keywords: ['bed', 'headboard'], category: 'Beds' },
];

export const KNOWN_OPTION_ORDER = ['Size', 'Color', 'Height', 'Size Type', 'Length', 'Fit'];

// ---- helpers ---------------------------------------------------------------

export function normalizeSite(site) {
  if (!site) return '';
  let s = String(site).trim().toLowerCase();
  s = s.replace(/^www\./, '');
  // Hostname mà extension v1.0.0 gửi (vd oglmove.com, eileenfisher.com, amazon.com):
  // bỏ TLD rồi map về slug dùng trong SITE_RANGES / luật.
  if (s.includes('.')) s = s.split('.')[0];
  const HOST_MAP = {
    oglmove: 'ogl-move',
    sohohome: 'soho-home',
    eileenfisher: 'eileen-fisher',
    azazie: 'azazie',
    prana: 'prana',
    amazon: 'amazon',
    walmart: 'walmart',
    ebay: 'ebay',
    aliexpress: 'aliexpress',
    zoro: 'zoro',
    staples: 'staples',
    etsy: 'etsy',
  };
  if (HOST_MAP[s]) return HOST_MAP[s];
  return s.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// cyrb53 — hash xác định, chạy được cả trình duyệt lẫn Node, không cần crypto.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Mã sản phẩm băm từ `source_site|source_product_id`. */
export function hashProductId(sourceSite, sourceProductId) {
  const site = normalizeSite(sourceSite);
  return `p_${cyrb53(`${site}|${String(sourceProductId).trim()}`)}`;
}

export function truncateTitle(title, max = MAX_TITLE_LENGTH) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd();
}

export function suggestCategory(title, _site) {
  const t = String(title ?? '').toLowerCase();
  for (const { keywords, category } of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => t.includes(k))) return category;
  }
  return null;
}

export function validatePrice(site, price) {
  const errors = [];
  if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0) {
    errors.push('price must be a positive number');
    return errors;
  }
  const range = SITE_RANGES[normalizeSite(site)];
  if (range && (Number(price) < range[0] || Number(price) > range[1])) {
    errors.push(`price ${price} outside reasonable range for ${normalizeSite(site)} (${range[0]}-${range[1]} USD)`);
  }
  return errors;
}

/** Giá bán = (giá nguồn + ship + thuế) × (1 + % lợi nhuận) ÷ (1 − % phí eBay), làm tròn .99. */
export function calcSellPrice(sourcePrice, config = {}) {
  const price = Number(sourcePrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const markupPct = Number(config.markupPct ?? 0.35);
  const feePct = Number(config.ebayFeePct ?? EBAY_FEE_PCT_DEFAULT);
  const shipping = Number(config.shippingCost ?? 0);
  const taxPct = Number(config.taxPct ?? 0);
  if (![markupPct, feePct, shipping, taxPct].every(Number.isFinite)
    || markupPct < 0 || feePct < 0 || feePct >= 1 || shipping < 0 || taxPct < 0) return null;
  let sell = (price + shipping + price * taxPct) * (1 + markupPct) / (1 - feePct);
  if (config.roundTo99 !== false) {
    sell = Math.max(0.99, Math.floor(sell) + 0.99);
  } else {
    sell = Math.round(sell * 100) / 100;
  }
  return Number.isFinite(sell) && sell > 0 ? sell : null;
}

function normalizeCurrency(value, fallback = 'USD') {
  return String(value ?? fallback).trim().toUpperCase() || fallback;
}

/** Giá niêm yết: giá team chốt là tiền tệ đích; tỷ giá do team cấu hình, không tự đoán. */
export function listingPriceForVariant(product, variant = null, config = {}, listingCurrency = config.listingCurrency ?? 'USD') {
  const edits = product.edits ?? {};
  if (edits.price != null) {
    const explicit = Number(edits.price);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : null;
  }
  const sourceCurrency = normalizeCurrency(variant?.currency ?? product.currency);
  const targetCurrency = normalizeCurrency(listingCurrency);
  const rate = sourceCurrency === targetCurrency ? 1 : Number(config.exchangeRates?.[sourceCurrency]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const sameCurrency = sourceCurrency === normalizeCurrency(product.currency);
  const sourcePrice = Number(variant?.price ?? (sameCurrency ? product.price : null));
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) return null;
  return calcSellPrice(sourcePrice * rate, { ...config, markupPct: edits.markupPct ?? config.markupPct });
}

function listingPriceOrThrow(product, variant, config, listingCurrency = config.listingCurrency ?? 'USD') {
  const sell = listingPriceForVariant(product, variant, config, listingCurrency);
  if (sell != null) return sell;
  const source = normalizeCurrency(variant?.currency ?? product.currency);
  const target = normalizeCurrency(listingCurrency);
  const missingRate = product.edits?.price == null && source !== target
    && !(Number.isFinite(Number(config.exchangeRates?.[source])) && Number(config.exchangeRates[source]) > 0);
  const error = new Error(missingRate
    ? `Sản phẩm "${product.title ?? product.id}": giá nguồn ${source}, CSV dùng ${target}. Cần chốt giá bán ${target} hoặc cấu hình exchangeRates.${source} trước khi xuất.`
    : `Sản phẩm "${product.title ?? product.id}": giá bán hoặc cấu hình giá không hợp lệ; cần giá bán hữu hạn lớn hơn 0 trước khi xuất.`);
  error.code = missingRate ? 'currency_conversion_required' : 'invalid_listing_price';
  error.productId = product.id;
  throw error;
}

function isListingPriceError(error) {
  return error?.code === 'currency_conversion_required' || error?.code === 'invalid_listing_price';
}

// Product-data exports may leave the listing price empty for later completion.
// This is opt-in: strict listing export still rejects missing/invalid prices.
function listingPriceForExport(product, variant, config, listingCurrency = config.listingCurrency ?? 'USD') {
  try {
    return listingPriceOrThrow(product, variant, config, listingCurrency);
  } catch (error) {
    if (config.allowIncompletePrice === true && isListingPriceError(error)) return null;
    throw error;
  }
}

function isVariantInStock(variant) {
  return variant?.in_stock !== false && variant?.available !== false
    && variant?.in_stock !== null && variant?.available !== null
    && !(variant?.stock_qty != null && Number.isFinite(Number(variant.stock_qty)) && Number(variant.stock_qty) <= 0);
}

function listingVariants(product) {
  const variants = product.variants ?? [];
  // Có dữ liệu tồn kho thì phải giữ kết luận hết hàng; chỉ tạo mặc định khi chưa có biến thể.
  return (variants.length ? variants : [{ options: {}, price: product.price, in_stock: product.in_stock, stock_qty: product.stock_qty }])
    .filter(isVariantInStock).slice(0, MAX_VARIANTS);
}

function templateListingCurrency(template, config = {}) {
  const templateCurrency = (template.headers ?? []).map((h) => String(h).match(/\bCurrency=([A-Za-z]{3})\b/i)?.[1]).find(Boolean);
  const currency = normalizeCurrency(templateCurrency ?? config.listingCurrency);
  if (config.listingCurrency && normalizeCurrency(config.listingCurrency) !== currency) {
    throw new Error(`Template dùng ${currency} nhưng cấu hình giá dùng ${normalizeCurrency(config.listingCurrency)}; cần chọn cùng tiền tệ trước khi xuất.`);
  }
  return currency;
}

// Kiểm từng sản phẩm trước khi xuất nhóm: một món thiếu tỷ giá/giá không làm mất file của món hợp lệ.
function listingProductsForGroup(group, template, config, skipped) {
  const currency = templateListingCurrency(template, config);
  const products = [];
  const issues = [];
  for (const product of dedupeProductsById(group.products).products) {
    const variants = listingVariants(product);
    if (!variants.length) {
      issues.push({ productId: product.id, code: 'no_available_variants', message: `"${product.title ?? product.id}": hết hàng hoặc chưa xác minh tồn kho.` });
      continue;
    }
    try {
      for (const variant of variants) listingPriceForExport(product, variant, config, currency);
      products.push(product);
    } catch (error) {
      issues.push({ productId: product.id, code: error.code, message: error.message });
    }
  }
  if (issues.length) skipped.push({
    key: group.key, label: group.label, productCount: issues.length,
    productIds: issues.map((issue) => issue.productId), issues,
    reason: issues.map((issue) => issue.message).join(' '),
  });
  return products;
}

// ---- variants --------------------------------------------------------------

/** Chuẩn hoá một biến thể: mọi tuỳ chọn vào `options`, không được bỏ tuỳ chọn thứ ba. */
export function normalizeVariant(raw, productPrice) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const options = {};
  // Dạng mới: options: {Size, Color, Height, ...}
  if (raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)) {
    for (const [k, v] of Object.entries(raw.options)) {
      if (v != null && String(v).trim() !== '') options[String(k).trim()] = String(v).trim();
    }
  }
  // Dạng cũ / rút gọn: size / color / extra_options
  if (raw.size != null && !options.Size) options.Size = String(raw.size).trim();
  if (raw.color != null && !options.Color) options.Color = String(raw.color).trim();
  if (raw.extra_options && typeof raw.extra_options === 'object' && !Array.isArray(raw.extra_options)) {
    for (const [k, v] of Object.entries(raw.extra_options)) {
      if (v != null && String(v).trim() !== '' && !options[k]) options[String(k).trim()] = String(v).trim();
    }
  }
  const price = raw.price != null ? Number(raw.price) : Number(productPrice);
  const compareAtPrice = raw.compare_at_price != null ? Number(raw.compare_at_price) : null;
  const stockQty = raw.stock_qty != null ? Number(raw.stock_qty) : null;
  return {
    options,
    price: Number.isFinite(price) && price > 0 ? price : null,
    compare_at_price: Number.isFinite(compareAtPrice) && compareAtPrice > 0 ? compareAtPrice : null,
    in_stock: raw.in_stock === false || raw.available === false || (stockQty != null && stockQty <= 0)
      ? false : raw.in_stock === null || raw.available === null ? null : true,
    stock_qty: Number.isFinite(stockQty) && stockQty >= 0 ? Math.floor(stockQty) : null,
    ...(raw.currency != null ? { currency: normalizeCurrency(raw.currency) } : {}),
    sku: raw.sku != null ? String(raw.sku) : null,
    upc: raw.upc != null ? String(raw.upc) : null,
    image: raw.image != null ? String(raw.image) : null,
  };
}

/** Tên các tuỳ chọn, theo thứ tự Size, Color, rồi các tuỳ chọn khác theo bảng chữ cái. */
export function optionNamesFor(variants) {
  const names = new Set();
  for (const v of variants || []) for (const k of Object.keys(v.options || {})) names.add(k);
  return [...names].sort((a, b) => {
    const ia = KNOWN_OPTION_ORDER.indexOf(a);
    const ib = KNOWN_OPTION_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

/** `Size=S|Color=Black|Height=Regular` — thứ tự Size, Color, rồi tuỳ chọn thêm. */
export function variantRelationshipDetails(variant) {
  const names = optionNamesFor([variant]);
  return names.map((n) => `${n}=${variant.options[n]}`).join('|');
}

// ---- records ---------------------------------------------------------------

/** Chuẩn hoá một record crawl (extension hoặc push-crawl) thành product. */
export function normalizeRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { product: null, errors: ['record must be an object'] };
  if (record.variants != null && !Array.isArray(record.variants)) errors.push('variants must be an array');
  if (record.images != null && !Array.isArray(record.images)) errors.push('images must be an array');
  if (errors.length) return { product: null, errors };
  const sourceSite = normalizeSite(record.source_site ?? record.source ?? record.site);
  const sourceProductId = String(record.source_product_id ?? record.source_id ?? record.id ?? '').trim();
  if (!sourceSite) errors.push('missing source_site');
  if (!sourceProductId) errors.push('missing source_product_id');
  const title = String(record.title ?? '').trim();
  if (!title) errors.push('missing title');
  // Extension v1.0.0 không gửi price ở cấp record — giá nằm ở từng variant.
  // Lấy giá sản phẩm = giá variant còn hàng thấp nhất, rồi tới variant đầu tiên.
  let price = record.price != null ? Number(record.price) : null;
  const rawVariants = record.variants ?? [];
  const currency = normalizeCurrency(record.currency ?? rawVariants.find((v) => v?.currency)?.currency);
  if ((price == null || !Number.isFinite(price) || price <= 0) && rawVariants.length) {
    const sameCurrencyVariants = rawVariants.filter((v) => normalizeCurrency(v?.currency ?? currency) === currency);
    const priced = sameCurrencyVariants.map((v) => Number(v?.price)).filter((n) => Number.isFinite(n) && n > 0);
    const inStockPriced = sameCurrencyVariants.filter(isVariantInStock).map((v) => Number(v?.price)).filter((n) => Number.isFinite(n) && n > 0);
    const pool = inStockPriced.length ? inStockPriced : priced;
    if (pool.length) price = Math.min(...pool);
  }
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('currency must be a three-letter code');
  if (rawVariants.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) errors.push('each variant must be an object');
  if (rawVariants.some((v) => v?.currency != null && !/^[A-Z]{3}$/.test(normalizeCurrency(v.currency)))) errors.push('variant currency must be a three-letter code');
  // Giá ngoài khoảng tham khảo chỉ là cảnh báo; số không hợp lệ mới chặn import.
  const priceWarnings = price != null ? validatePrice(currency === 'USD' ? sourceSite : '', price) : [];
  if (price != null && (!Number.isFinite(price) || price <= 0)) errors.push(...priceWarnings);
  if (errors.length) return { product: null, errors };

  const variants = [];
  for (const raw of rawVariants) {
    const v = normalizeVariant(raw, normalizeCurrency(raw.currency ?? currency) === currency ? price : null);
    if (v) variants.push(v);
  }
  // Sản phẩm đơn vẫn giữ SKU/UPC/ảnh/tồn kho, dù không có tuỳ chọn size/màu.
  const finalVariants = variants.length ? variants : [normalizeVariant(record, price)];
  const inStock = finalVariants.filter((v) => v.in_stock);
  let truncated = Boolean(record.truncated ?? record.crawl_truncated);
  if (inStock.length > MAX_VARIANTS) {
    truncated = true;
  }
  const images = [...new Set((record.images ?? []).map(String).filter(Boolean))].slice(0, MAX_IMAGES);
  const extraOptions = {};
  if (record.extra_options && typeof record.extra_options === 'object') Object.assign(extraOptions, record.extra_options);
  // Extension v1.0.0: tên tuỳ chọn ở cấp record (`options: ["Size","Color","Height"]`),
  // cờ giá ước tính ở `flags.price_estimated`, mô tả ở `description_text`.
  const topOptions = Array.isArray(record.options) ? record.options.map(String) : [];
  const optionNames = optionNamesFor(finalVariants);
  for (const n of topOptions) if (!optionNames.includes(n)) optionNames.push(n);
  const firstUpc = finalVariants.map((v) => v.upc).find(Boolean) ?? null;
  const product = {
    id: hashProductId(sourceSite, sourceProductId),
    source_site: sourceSite,
    source_product_id: sourceProductId,
    source_url: record.source_url ?? record.url ?? null,
    title: truncateTitle(title),
    title_raw: title,
    brand: record.brand ? String(record.brand).trim() : null,
    price,
    currency,
    images,
    // Link ảnh gốc của trang bán lẻ (v9.1): khi ảnh đã upload lên
    // Cloudflare R2 thì images là link Cloudflare, originalImages giữ link
    // gốc để đối chiếu. Chưa upload thì originalImages null.
    originalImages: Array.isArray(record.originalImages)
      ? [...new Set(record.originalImages.map(String).filter(Boolean))]
      : null,
    variants: finalVariants,
    option_names: optionNames,
    extra_options: extraOptions,
    category: record.category ? String(record.category) : null,
    suggested_category: suggestCategory(title, sourceSite),
    price_estimated: Boolean(record.price_estimated ?? record.flags?.price_estimated) || ['amazon', 'azazie'].includes(sourceSite),
    truncated,
    in_stock_count: inStock.length,
    variant_count: finalVariants.length,
    upc: firstUpc,
    breadcrumb: Array.isArray(record.breadcrumb) ? record.breadcrumb.map(String) : [],
    department: record.department ? String(record.department) : null,
    attributes: record.attributes && typeof record.attributes === 'object' ? record.attributes : {},
    specs: record.specs && typeof record.specs === 'object' ? record.specs : {},
    description: record.description_text ?? record.description ?? null,
    edits: {},
    product_type: record.product_type ? String(record.product_type) : null,
    // Chủ đề/NGÁCH do team ghi trong sheet (vd "Gối", "Thảm") hoặc extension
    // bulk crawl gửi kèm ("url | chủ đề"). Dùng để chia nhóm xuất CSV.
    theme: record.theme ?? record.ngach ?? null,
    // Category eBay đã chốt (mã số, vd "20563") nếu record có — ưu tiên khi nhóm.
    category_id: record.category_id ?? record.categoryId ?? null,
    // Số liệu eBay tham khảo (v9.1, TỰ ĐỘNG qua Browse API): tổng số đã
    // bán ƯỚC TÍNH của listing tương ứng (estimatedSoldQuantity) và số
    // người theo dõi (watchCount) — tool tự tìm listing khớp theo tên +
    // giá, không cần seller dán link hay dán số. Số liệu là tổng cả
    // listing, không chia theo màu/size. Không có thì null.
    ebaySold: Number.isInteger(record.ebaySold) && record.ebaySold >= 0 ? record.ebaySold : null,
    ebayWatchers: Number.isInteger(record.ebayWatchers) && record.ebayWatchers >= 0 ? record.ebayWatchers : null,
    ebayItemId: record.ebayItemId ? String(record.ebayItemId).trim() : null,
    ebayWatchersSource: record.ebayWatchersSource ? String(record.ebayWatchersSource).trim() : null,
    // Listing eBay đã khớp tự động (v9.1): tiêu đề/link listing + điểm
    // khớp (0–1) + nguồn ('browse-api' hoặc 'manual' khi seller sửa tay).
    ebayItemTitle: record.ebayItemTitle ? String(record.ebayItemTitle).trim() : null,
    ebayItemUrl: record.ebayItemUrl ? String(record.ebayItemUrl).trim() : null,
    ebayMatchScore: (record.ebayMatchScore != null && Number.isFinite(Number(record.ebayMatchScore)))
      ? Math.max(0, Math.min(1, Number(record.ebayMatchScore)))
      : null,
    ebayMatchSource: record.ebayMatchSource ? String(record.ebayMatchSource).trim() : null,
    version: 1,
    crawled_at: record.crawled_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    crawl_errors: [...(Array.isArray(record.crawl_errors ?? record.errors) ? (record.crawl_errors ?? record.errors) : []), ...priceWarnings],
  };
  return { product, errors };
}

/**
 * Nhập một lô record. Trùng (cùng source_site|source_product_id) được gộp:
 * bản ghi sau trong cùng lô thắng cho dữ liệu nguồn, nhưng giữ edits/product_type.
 */
export function parseImport(records, existingById = new Map()) {
  const products = [];
  const byId = new Map(existingById);
  const errors = [];
  let mergedDuplicates = 0;
  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    const { product, errors: errs } = normalizeRecord(record);
    if (!product) {
      errors.push({
        source_site: normalizeSite(record?.source_site ?? record?.source ?? ''),
        source_product_id: String(record?.source_product_id ?? record?.source_id ?? ''),
        message: errs.join('; '),
      });
      continue;
    }
    const existing = byId.get(product.id);
    if (existing) {
      mergedDuplicates += 1;
      const merged = mergeProducts(existing, product);
      byId.set(product.id, merged);
      const idx = products.findIndex((p) => p.id === product.id);
      if (idx >= 0) products[idx] = merged;
      else products.push(merged);
    } else {
      byId.set(product.id, product);
      products.push(product);
    }
  }
  return {
    products,
    errors,
    stats: { total: list.length, imported: products.length, mergedDuplicates, errors: errors.length },
  };
}

/**
 * Nhập lại cùng sản phẩm: dữ liệu nguồn mới (giá, tồn, biến thể, ảnh, tiêu đề)
 * thay dữ liệu cũ. Phần team đã sửa (`edits`) và `product_type` vẫn giữ.
 */
export function mergeProducts(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    ...incoming,
    id: existing.id,
    edits: existing.edits ?? {},
    product_type: existing.product_type ?? incoming.product_type ?? null,
    theme: existing.theme ?? incoming.theme ?? null,
    category_id: existing.category_id ?? incoming.category_id ?? null,
    // Team đã chốt category thì không để crawl ghi đè.
    category: existing.edits?.category ?? existing.category ?? incoming.category ?? null,
    // Số liệu eBay tham khảo (v9.1): crawl lại không có thì giữ số cũ của
    // team; có số mới (vd Browse API vừa tìm lại listing khớp) thì số mới
    // thắng. Listing đã khớp (tiêu đề/link/điểm khớp) giữ theo cùng luật.
    ebaySold: incoming.ebaySold ?? existing.ebaySold ?? null,
    ebayWatchers: incoming.ebayWatchers ?? existing.ebayWatchers ?? null,
    ebayItemId: incoming.ebayItemId ?? existing.ebayItemId ?? null,
    ebayWatchersSource: incoming.ebayWatchersSource ?? existing.ebayWatchersSource ?? null,
    ebayItemTitle: incoming.ebayItemTitle ?? existing.ebayItemTitle ?? null,
    ebayItemUrl: incoming.ebayItemUrl ?? existing.ebayItemUrl ?? null,
    ebayMatchScore: incoming.ebayMatchScore ?? existing.ebayMatchScore ?? null,
    ebayMatchSource: incoming.ebayMatchSource ?? existing.ebayMatchSource ?? null,
    // Ảnh gốc (v9.1): crawl lại không có originalImages thì giữ link gốc
    // cũ của team; bản ghi mới có thì bản mới thắng.
    originalImages: incoming.originalImages ?? existing.originalImages ?? null,
    version: (existing.version ?? 1) + 1,
    crawled_at: incoming.crawled_at ?? existing.crawled_at,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Hai bản ghi có phải cùng một sản phẩm không (v8.3)? Chỉ so id là KHÔNG
 * đủ: id băm từ slug (vd "vinnie-cushion") nên 2 sản phẩm THẬT KHÁC NHAU
 * vẫn trùng id — "Vinnie Cushion Bisque" (/us/products/vinnie-cushion/
 * 79958889) và "Vinnie Cushion Sage" (/us/products/vinnie-cushion) trong
 * sheet thật. Phải trùng cả URL sản phẩm đã chuẩn hoá (bỏ "/" cuối, www,
 * query...) mới gộp; khi một bên thiếu URL thì so tiêu đề đã chuẩn hoá
 * (bỏ tiền tố "Soho Home", bỏ dấu câu, lowercase).
 */
function sameProduct(a, b) {
  if (!a || !b || a.id !== b.id) return false;
  const ua = normalizeProductUrl(a.source_url);
  const ub = normalizeProductUrl(b.source_url);
  if (ua && ub) return ua === ub;
  const ta = normalizeTitleForCompare(a.title);
  const tb = normalizeTitleForCompare(b.title);
  return ta !== '' && ta === tb;
}

function normalizeTitleForCompare(t) {
  return String(t ?? '').toLowerCase().replace(/^soho home\s+/i, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Gộp các sản phẩm TRÙNG (cùng id + cùng URL sản phẩm, xem sameProduct)
 * thành 1 (lưới an toàn cuối cùng trước khi nhóm/xuất, v8.3): bản ghi đã
 * crawl/enrich làm nền, bản còn lại chỉ lấp chỗ trống (ảnh/mô tả/giá từ
 * sheet) và GIÁ BÁN trong edits nếu nền chưa có; edits của team trên bản
 * nền luôn thắng. Trả { products, mergedDuplicateProducts } — số bản ghi
 * trùng đã gộp (0 khi không trùng). Dùng mergeProducts để gộp (bản nền
 * thắng dữ liệu, giữ id), rồi gộp edits tay để không mất GIÁ BÁN từ sheet
 * hay edits của team.
 */
function isCrawledRecord(p) {
  return Boolean(p && !p.sheet_only && ((p.images ?? []).length > 0 || p.specs || p.source_url));
}

export function dedupeProductsById(products) {
  const kept = [];
  let mergedDuplicateProducts = 0;
  for (const p of products ?? []) {
    if (!p || !p.id) { kept.push(p); continue; }
    const idx = kept.findIndex((q) => q && q.id && sameProduct(q, p));
    if (idx === -1) { kept.push(p); continue; }
    mergedDuplicateProducts++;
    const prev = kept[idx];
    const base = isCrawledRecord(prev) ? prev : (isCrawledRecord(p) ? p : prev);
    const other = base === prev ? p : prev;
    const merged = mergeProducts(other, base);
    // mergeProducts lấy edits của `other` — gộp lại: edits của base (team
    // đã chốt / GIÁ BÁN đã enrich từ sheet) thắng, chỉ lấp chỗ trống bằng
    // edits của other (vd GIÁ BÁN của bản sheet fallback).
    merged.edits = { ...(other.edits ?? {}), ...(base.edits ?? {}) };
    if (!(merged.images ?? []).length && (other.images ?? []).length) merged.images = other.images;
    if (!merged.description && other.description) merged.description = other.description;
    if (!merged.title && other.title) merged.title = other.title;
    if (!merged.brand && other.brand) merged.brand = other.brand;
    if ((merged.price == null || merged.price <= 0) && other.price != null && other.price > 0) merged.price = other.price;
    merged.sheet_only = Boolean(base.sheet_only && other.sheet_only);
    merged.source_url = base.source_url ?? other.source_url;
    kept[idx] = merged;
  }
  return { products: kept, mergedDuplicateProducts };
}

/** Áp edits của team lên product để duyệt/xuất. */
export function applyEdits(product, config = {}) {
  const edits = product.edits ?? {};
  const sellPrice = listingPriceForVariant(product, null, config);
  return {
    ...product,
    title: edits.title ? truncateTitle(edits.title) : product.title,
    category: edits.category ?? product.category ?? product.suggested_category ?? null,
    price: product.price,
    sell_price: sellPrice,
    description: edits.description ?? product.description ?? null,
  };
}

// ---- CSV -------------------------------------------------------------------

/** Ô CSV mà Excel/Sheets sẽ hiểu là công thức (CSV/formula injection):
 *  bắt đầu bằng = + - @ tab hoặc CR. Số thuần (vd -5, +1.5) không tính. */
export function looksLikeCsvFormula(value) {
  if (value == null) return false;
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:[.,]\d+)?$/.test(s.trim());
}

/** neutralizeFormulas: thêm dấu ' trước ô dạng công thức — CHỈ dùng cho file
 *  xem bằng Excel (research). File upload Seller Hub giữ nguyên dữ liệu và
 *  được cảnh báo trong validateEbayTemplateProducts thay vì sửa ngầm. */
export function csvEscape(value, { neutralizeFormulas = false } = {}) {
  if (value == null) return '';
  let s = String(value);
  if (neutralizeFormulas && looksLikeCsvFormula(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADERS = [
  'Action',
  'Custom label (SKU)',
  'Category',
  'Title',
  'Description',
  'Condition',
  'Price',
  'Quantity',
  'PicURL',
  'UPC',
  'C:Brand',
  'C:Size',
  'C:Color',
  'Relationship',
  'Relationship details',
];

// Each SKU is a standalone listing. A grouped eBay variation listing requires
// a separate parent row and category support, which this exporter does not assume.
function listingImagesForVariant(product, variant) {
  const images = product.images ?? [];
  const sourceImage = String(variant.image ?? '').trim();
  const originalIndex = (product.originalImages ?? []).indexOf(sourceImage);
  const primary = originalIndex >= 0 && images[originalIndex] ? images[originalIndex] : sourceImage;
  return [...new Set([primary, ...images].filter(Boolean))];
}

/** CSV đơn giản: mỗi SKU còn hàng là một listing riêng, đủ nội dung trên từng dòng. */
export function buildCsv(products, config = {}) {
  const explicitCountry = Object.prototype.hasOwnProperty.call(config, 'ebayCountry');
  const country = String(config.ebayCountry ?? '').trim().toUpperCase();
  const extraOptions = optionNamesFor((products ?? []).flatMap((p) => listingVariants(p)))
    .filter((name) => !CSV_HEADERS.some((h) => h.toLowerCase() === `c:${name.toLowerCase()}`));
  const rows = [[...CSV_HEADERS, ...extraOptions.map((name) => `C:${name}`), ...(explicitCountry ? ['Country'] : [])]];
  for (const raw of products || []) {
    const p = applyEdits(raw, config);
    const list = listingVariants(p);
    if (!list.length) continue;
    const baseSku = p.id;
    list.forEach((variant, i) => {
      const sku = variant.sku ?? (list.length > 1 ? `${baseSku}-${i + 1}` : baseSku);
      const sell = listingPriceForExport(p, variant, config);
      rows.push([
        'Add',
        sku,
        p.category ?? '',
        p.title,
        p.description ?? '',
        'New',
        sell != null ? sell.toFixed(2) : '',
        1,
        listingImagesForVariant(p, variant).join('|'),
        variant.upc ?? (list.length === 1 ? (p.upc ?? '') : ''),
        p.brand ?? '',
        aspectFromProduct(p, variant, 'Size') ?? '',
        aspectFromProduct(p, variant, 'Color') ?? '',
        '',
        '',
        ...extraOptions.map((name) => aspectFromProduct(p, variant, name) ?? ''),
        ...(explicitCountry ? [country] : []),
      ]);
    });
  }
  return CSV_UTF8_BOM + rows.map((r) => r.map((v) => csvEscape(v)).join(',')).join('\r\n') + '\r\n';
}

// ---- eBay File Exchange template -----------------------------------------
// Template thật do eBay xuất: dòng 0 = Info Version, dòng 1 = header
// (vd 98 cột, category 20563), các dòng sau header là dòng Info gợi ý
// (required aspects, recommended values...), rồi mới tới dòng sản phẩm.
// parseEbayTemplate giữ nguyên các dòng này để buildEbayTemplateCsv xuất
// lại y hệt, chỉ thêm dòng sản phẩm vào cuối.

/** Parse CSV text bất kỳ (kể cả template eBay): xử lý dấu ngoặc kép, xuống dòng trong field, BOM. */
export function parseCsvText(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      fieldStarted = false;
      rows.push(row);
      row = [];
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (field !== '' || fieldStarted || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Bỏ dòng trống cuối do ký tự xuống dòng cuối file.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/** BOM UTF-8 (EF BB BF): mọi file CSV xuất ra đều bắt đầu bằng BOM để
 *  Excel trên Windows đọc đúng tiếng Việt (dòng cảnh báo DRAFT, mô tả...).
 *  File template thật của eBay đã có BOM nên BOM an toàn khi upload lên
 *  Seller Hub. parseCsvText đã bỏ BOM khi đọc lại nên parse vẫn đúng. */
export const CSV_UTF8_BOM = '\uFEFF';

export function serializeCsvRows(rows, opts = {}) {
  return CSV_UTF8_BOM + rows.map((r) => r.map((v) => csvEscape(v, opts)).join(',')).join('\r\n') + '\r\n';
}

/**
 * Parse file template eBay thật thành
 * { version, template, categoryId, headers, infoRows, requiredAspects,
 *   recommendedValues, versionRow, rawRows }.
 * infoRows = mọi dòng sau header (gồm cả dòng trống) — buildEbayTemplateCsv
 * giữ nguyên chúng trong file xuất.
 */
export function parseEbayTemplate(csvText) {
  const rows = parseCsvText(csvText);
  if (rows.length < 2) throw new Error('Template eBay phải có ít nhất dòng Info Version và dòng header.');
  const versionRow = rows[0];
  if (versionRow[0] !== 'Info') throw new Error('Template eBay không đúng định dạng File Exchange: dòng đầu phải bắt đầu bằng Info.');
  const headers = rows[1];
  if (!headers[0] || !headers[0].startsWith('*Action')) {
    throw new Error('Template eBay không đúng định dạng File Exchange: dòng header phải bắt đầu bằng *Action.');
  }
  const version = versionRow[1] ?? null;
  const template = versionRow[2] ?? null;
  const infoRows = rows.slice(2);
  let categoryId = null;
  let requiredAspects = [];
  const recommendedValues = {};
  let lastAspect = null;
  for (const r of infoRows) {
    const text = r[1] ?? '';
    let m = text.match(/For categoryId:\s*(\d+)/);
    if (m) categoryId = m[1];
    m = text.match(/The required aspects are (.+)/i);
    if (m) requiredAspects = m[1].split(';').map((s) => s.trim()).filter(Boolean);
    m = text.match(/^>>> The recommended value\(s\) for aspect (.+?): (.*)$/);
    if (m) {
      lastAspect = m[1].trim();
      recommendedValues[lastAspect] = m[2].split(';').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (/^>>> Condition Help/i.test(text)) { lastAspect = null; continue; }
    // Dòng nối tiếp của aspect trước (vd danh sách Brand dài, tràn sang
    // nhiều dòng Info): cộng dồn giá trị vào aspect đó.
    if (r[0] === 'Info' && lastAspect && text.trim()) {
      recommendedValues[lastAspect].push(...text.split(';').map((s) => s.trim()).filter(Boolean));
    }
  }
  return { version, template, categoryId, headers, infoRows, requiredAspects, recommendedValues, versionRow, rawRows: rows };
}

// ---- Chia nhóm theo chủ đề -------------------------------------------------

/** Từ khoá trong tiêu đề -> nhóm chủ đề. Thứ tự quan trọng (gối trước textiles vì "Throw Pillow" chứa "Throw"). */
export const THEME_KEYWORDS = [
  { keywords: ['cushion', 'pillow', 'bolster', 'sham'], key: 'cushions', label: 'Cushions & Pillows', categoryId: '20563' },
  { keywords: ['rug', 'runner', 'carpet'], key: 'rugs', label: 'Rugs' },
  { keywords: ['lamp', 'chandelier', 'sconce', 'pendant', 'light'], key: 'lighting', label: 'Lighting' },
  { keywords: ['sofa', 'armchair', 'chaise', 'chair', 'bench', 'stool', 'ottoman'], key: 'seating', label: 'Seating' },
  { keywords: ['bed', 'headboard', 'mattress'], key: 'beds', label: 'Beds & Bedroom' },
  { keywords: ['table', 'desk'], key: 'tables', label: 'Tables' },
  { keywords: ['mirror'], key: 'mirrors', label: 'Mirrors' },
  { keywords: ['cabinet', 'sideboard', 'dresser', 'wardrobe', 'shelf', 'bookcase', 'chest'], key: 'storage', label: 'Storage & Cabinets' },
  { keywords: ['curtain', 'throw', 'blanket', 'duvet', 'bedding'], key: 'textiles', label: 'Textiles & Bedding' },
  { keywords: ['vase', 'sculpture', 'candle', 'decor', 'wall art'], key: 'decor', label: 'Home Decor' },
  { keywords: ['dinnerware', 'plate', 'bowl', 'glass', 'cutlery', 'kitchen'], key: 'kitchen', label: 'Kitchen & Dining' },
  { keywords: ['bath', 'towel', 'toilet', 'robe', 'bin'], key: 'bath', label: 'Bath' },
];

export function slugifyTheme(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** NGÁCH trong sheet thường ghi tiếng Việt ("Gối", "Thảm", "Đèn", "Bàn ghế").
 *  Map về nhóm THEME_KEYWORDS để chia nhóm + gán categoryId đúng (vd "Gối" -> cushions, 20563). */
export const THEME_VI_KEYWORDS = [
  { keywords: ['gối', 'goi'], key: 'cushions' },
  { keywords: ['thảm', 'tham'], key: 'rugs' },
  { keywords: ['đèn', 'den', 'đèn chùm'], key: 'lighting' },
  { keywords: ['gương', 'guong'], key: 'mirrors' },
  { keywords: ['giường', 'giuong'], key: 'beds' },
  { keywords: ['bàn', 'ban'], key: 'tables' },
  { keywords: ['ghế', 'ghe', 'sofa', 'ghế dài'], key: 'seating' },
  { keywords: ['tủ', 'tu', 'kệ', 'ke'], key: 'storage' },
  { keywords: ['rèm', 'rem', 'chăn', 'chan', 'ga giường'], key: 'textiles' },
  { keywords: ['trang trí', 'trang tri', 'decor'], key: 'decor' },
  { keywords: ['bếp', 'bep', 'bát', 'bat', 'đĩa'], key: 'kitchen' },
  { keywords: ['phòng tắm', 'phong tam', 'khăn'], key: 'bath' },
];

/** Tìm nhóm chủ đề từ chuỗi theme/NGÁCH (tiếng Việt hoặc tiếng Anh). */
export function resolveThemeGroup(theme) {
  const t = String(theme ?? '').toLowerCase();
  if (!t.trim()) return null;
  const vi = THEME_VI_KEYWORDS.find((g) => g.keywords.some((k) => t.includes(k)));
  if (vi) return THEME_KEYWORDS.find((g) => g.key === vi.key) ?? null;
  return THEME_KEYWORDS.find((g) => g.keywords.some((k) => t.includes(k))) ?? null;
}

/**
 * Mã danh mục đã xác minh từ eBay Taxonomy, đọc từ edits của sản phẩm
 * (lưu qua POST /api/ebay/resolve-groups + PUT sau khi team bấm chấp nhận).
 * Trả {categoryId, categoryName, categoryPath, requiredAspects,
 * recommendedAspects, verifiedFromEbay: true} hoặc null khi chưa có mã.
 * CHỈ mã từ Taxonomy API (hoặc template thật) mới được xuất file upload
 * được — mã do AI đoán (edits.draftCategorySuggestion) KHÔNG BAO GIỜ
 * đi qua đây.
 * Các aspect giữ nguyên dạng {name, values[]} (v9.4, normalizeAspectEntries)
 * thay vì chỉ tên — để lúc xuất file khớp được C:Type với danh sách giá
 * trị eBay trả về cho danh mục đó. Dữ liệu cũ lưu dạng tên-only (chuỗi)
 * vẫn đọc được: values khi đó là []. */
export function resolvedCategoryFromEdits(edits, categoryId = null) {
  const id = (categoryId ?? edits?.ebayCategoryId ?? '').toString().trim();
  if (!id) return null;
  return {
    categoryId: id,
    categoryName: (edits?.ebayCategoryName ?? '').toString().trim() || null,
    categoryPath: (edits?.ebayCategoryPath ?? '').toString().trim() || null,
    requiredAspects: normalizeAspectEntries(edits?.ebayRequiredAspects),
    recommendedAspects: normalizeAspectEntries(edits?.ebayRecommendedAspects),
    verifiedFromEbay: true,
    // A legacy saved ID is not evidence that eBay returned an empty schema.
    ...(!Array.isArray(edits?.ebayRequiredAspects) && !Array.isArray(edits?.ebayRecommendedAspects)
      ? { aspectSchemaAvailable: false } : {}),
  };
}

/** Giá trị của một item specific (dùng cho báo cáo trường còn thiếu của
 *  nhóm đã có mã từ Taxonomy): ưu tiên edits.aiSpecifics đã duyệt, rồi
 *  attributes/specs của sản phẩm. */
export function getAspectValue(product, name) {
  const variants = product?.variants ?? [];
  const inStock = variants.filter((v) => v.in_stock);
  const variant = inStock[0] ?? variants[0] ?? {};
  return aspectFromProduct(product ?? {}, variant, name);
}

/**
 * Ghi kết quả tra mã từ eBay (POST /api/ebay/resolve-groups) vào nhóm +
 * sản phẩm: nhóm được gán categoryId + resolvedCategory để xuất file
 * upload được; sản phẩm được ghi edits.ebayCategoryId / Name / Path /
 * Aspects để lần sau mở lại vẫn còn. Chỉ áp cho nhóm có mã (categoryId
 * khác rỗng); nhóm chưa tra được mã giữ nguyên (vẫn ra file nháp như v7).
 * Trả {appliedGroups, appliedProducts}.
 */
export function applyTaxonomyResolutions(products, groups, resolutions) {
  const byKey = new Map(
    (resolutions ?? [])
      .filter((r) => r && typeof r === 'object' && (r.categoryId ?? '').toString().trim())
      .map((r) => [slugifyTheme(r.groupKey), r]),
  );
  if (!byKey.size) return { appliedGroups: 0, appliedProducts: 0 };
  let appliedGroups = 0;
  let appliedProducts = 0;
  for (const g of groups ?? []) {
    const r = byKey.get(slugifyTheme(g.key));
    if (!r || g.key === 'chua-phan-loai') continue;
    // Giữ nguyên {name, values[]} của aspect (v9.4) — values là danh sách
    // giá trị cho phép eBay trả về, lúc xuất file dùng để khớp C:Type.
    g.categoryId = String(r.categoryId);
    g.resolvedCategory = {
      categoryId: String(r.categoryId),
      categoryName: (r.categoryName ?? '').toString().trim() || null,
      categoryPath: (r.categoryPath ?? '').toString().trim() || null,
      requiredAspects: normalizeAspectEntries(r.requiredAspects),
      recommendedAspects: normalizeAspectEntries(r.recommendedAspects),
      verifiedFromEbay: true,
    };
    appliedGroups++;
    for (const p of g.products ?? []) {
      p.edits = { ...(p.edits ?? {}) };
      p.edits.ebayCategoryId = String(r.categoryId);
      if (r.categoryName) p.edits.ebayCategoryName = r.categoryName;
      if (r.categoryPath) p.edits.ebayCategoryPath = r.categoryPath;
      p.edits.ebayRequiredAspects = normalizeAspectEntries(r.requiredAspects);
      p.edits.ebayRecommendedAspects = normalizeAspectEntries(r.recommendedAspects);
      appliedProducts++;
    }
  }
  return { appliedGroups, appliedProducts };
}

/**
 * Tự áp mã danh mục đã tra được từ eBay vào sản phẩm (v9.3 — thay nút
 * "Áp dụng mã" tay): với mỗi kết quả resolve-groups có categoryId VÀ
 * verifiedFromEbay === true, gọi putProduct(product, edits) cho từng sản
 * phẩm trong nhóm để lưu edits.ebayCategoryId/Name/Path/Aspects (PUT kèm
 * version check 409 ở phía putProduct). Sản phẩm đã có đúng mã đó rồi thì
 * bỏ qua, không PUT lại. Lỗi 409 (version lệch) hoặc lỗi khác ở 1 sản phẩm
 * thì chỉ tính vào failed + ghi warning, KHÔNG dừng cả nhóm.
 * QUAN TRỌNG: kết quả KHÔNG có verifiedFromEbay === true (mã do AI đoán,
 * draftCategorySuggestion, hoặc categoryId trống) thì KHÔNG BAO GIỜ gọi
 * putProduct — mã đó không được lưu, nhóm giữ file nháp.
 * Trả {perGroup: [{groupKey, categoryId, applied, failed, warning}],
 * applied, failed, skipped}.
 */
export async function autoApplyEbayResolutions(results, groups, putProduct) {
  const byKey = new Map((groups ?? []).map((g) => [slugifyTheme(g.key), g]));
  const findGroup = (key) => byKey.get(slugifyTheme(key))
    ?? (groups ?? []).find((g) => g.key === key) ?? null;
  const perGroup = [];
  let applied = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results ?? []) {
    const groupKey = String(r?.groupKey ?? r?.key ?? '').trim();
    const group = findGroup(groupKey);
    if (!r?.categoryId || r.verifiedFromEbay !== true) {
      skipped++;
      perGroup.push({
        groupKey,
        categoryId: null,
        applied: 0,
        failed: 0,
        warning: !r?.categoryId
          ? (r?.warning ?? 'eBay không gợi ý được mã cho nhóm này — giữ file nháp.')
          : 'Mã chưa xác minh từ eBay nên KHÔNG tự áp — giữ file nháp.',
      });
      continue;
    }
    if (!group || groupKey === 'chua-phan-loai') {
      skipped++;
      perGroup.push({ groupKey, categoryId: null, applied: 0, failed: 0, warning: 'Không tìm thấy nhóm này trong danh sách hiện tại.' });
      continue;
    }
    const categoryId = String(r.categoryId);
    let gApplied = 0;
    let gFailed = 0;
    const warnings = [];
    for (const p of group.products ?? []) {
      if ((p.edits?.ebayCategoryId ?? '').toString().trim() === categoryId) {
        gApplied++; // Đã có đúng mã này rồi — không PUT lại.
        continue;
      }
      const edits = {
        ...(p.edits ?? {}),
        ebayCategoryId: categoryId,
        ebayCategoryName: (r.categoryName ?? '').toString().trim() || null,
        ebayCategoryPath: (r.categoryPath ?? '').toString().trim() || null,
        // Giữ nguyên {name, values[]} của aspect (v9.4) — values là danh
        // sách giá trị cho phép eBay trả về, lúc xuất file dùng để khớp C:Type.
        ebayRequiredAspects: normalizeAspectEntries(r.requiredAspects),
        ebayRecommendedAspects: normalizeAspectEntries(r.recommendedAspects),
      };
      try {
        const updated = await putProduct(p, edits);
        if (updated) Object.assign(p, updated);
        else p.edits = edits;
        gApplied++;
      } catch (err) {
        gFailed++;
        warnings.push(`${p.title ?? p.id}: ${err?.status === 409 ? 'version lệch (409)' : (err?.message ?? 'lỗi không rõ')}`);
      }
    }
    applied += gApplied;
    failed += gFailed;
    perGroup.push({
      groupKey,
      categoryId,
      applied: gApplied,
      failed: gFailed,
      warning: warnings.length ? warnings.slice(0, 3).join('; ') : null,
    });
  }
  return { perGroup, applied, failed, skipped };
}

const MISSING = 'chưa có';

/** Giá trị specs/attributes theo tên (không phân biệt hoa thường). */
function specValue(product, name) {
  const wanted = String(name).toLowerCase();
  for (const bag of [product?.specs, product?.attributes]) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag)) {
      if (String(k).toLowerCase() === wanted && String(v ?? '').trim()) return String(v).trim();
    }
  }
  return null;
}

// v9.7: hiển thị đúng tiền tệ trang gốc (Floria UK là £175, không phải
// $175). Giá bán gợi ý (sell_price) là giá bán trên eBay US nên vẫn $.
const CUR_SYM = { USD: '$', GBP: '£', EUR: '€', VND: '₫', JPY: '¥', CAD: 'C$', AUD: 'A$', NZD: 'NZ$', INR: '₹', KRW: '₩' };
function moneyOrMissing(n, cur) {
  const v = Number(n);
  if (!Number.isFinite(v)) return MISSING;
  const c = String(cur ?? 'USD').toUpperCase();
  const sym = CUR_SYM[c] ?? (c ? `${c} ` : '$');
  return `${sym}${v.toFixed(2)}`;
}

/**
 * Danh sách "Đã cào được" cho 1 sản phẩm (v9.3): liệt kê gọn đã cào được
 * những thông tin gì, để web (tab Duyệt, chi tiết sản phẩm) và popup
 * extension cùng hiển thị 1 dạng duy nhất. Trả [{label, value, url?}] —
 * value luôn là chuỗi; trường nào chưa có thì ghi "chưa có", KHÔNG bịa.
 * Biến thể liệt kê tối đa 8 dòng (màu/size + giá từng biến thể), còn lại
 * gộp thành "+n biến thể nữa". Số đã bán / người theo dõi là TỔNG cả
 * listing eBay (không chia màu/size); số đã bán là ước tính của eBay.
 */
export function crawledSummaryItems(product, config = {}) {
  const p = product ?? {};
  const eff = applyEdits(p, config);
  const title = (eff.title ?? p.title ?? '').toString().trim();
  const images = Array.isArray(p.images) ? p.images : [];
  const desc = (p.description ?? '').toString();
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const names = p.option_names ?? optionNamesFor(variants);
  const variantText = !variants.length ? MISSING : variants.slice(0, 8).map((v) => {
    const opts = names.map((n) => v.options?.[n]).filter(Boolean).join(' / ') || '—';
    return `${opts} — ${moneyOrMissing(v.price, v.currency ?? p.currency)}${v.in_stock ? '' : ' (Hết)'}`;
  }).join('; ') + (variants.length > 8 ? ` … (+${variants.length - 8} biến thể nữa)` : '');
  const categoryId = (p.edits?.ebayCategoryId ?? '').toString().trim();
  const categoryName = (p.edits?.ebayCategoryName ?? '').toString().trim();
  return [
    { label: 'Tiêu đề', value: title || MISSING },
    { label: 'Giá', value: p.price != null ? `${moneyOrMissing(p.price, p.currency)}${eff.sell_price != null ? ` (giá bán gợi ý ${moneyOrMissing(eff.sell_price)})` : ''}` : MISSING },
    { label: 'Ảnh', value: images.length ? `${images.length} ảnh` : MISSING },
    { label: 'Mô tả', value: desc.trim() ? `có — ${desc.trim().length} ký tự` : MISSING },
    { label: 'Chất liệu', value: specValue(p, 'Material') ?? MISSING },
    { label: 'Kích thước', value: specValue(p, 'Dimensions') ?? MISSING },
    // Đèn (v9.5, v9.7): loại bóng + công suất, chăm sóc — lấy từ specs đào
    // được ở panel "Details & Dimensions". Floria dùng nhãn 'Bulb
    // required' / 'Bulb style' thay cho 'Bulb type' nên gộp cả 3 nhãn
    // (trùng nhau thì chỉ giữ 1 lần); chưa có thì "chưa có", không bịa.
    {
      label: 'Bóng đèn',
      value: (() => {
        const parts = [...new Set(['Bulb required', 'Bulb type', 'Bulb style'].map((k) => specValue(p, k)).filter(Boolean))];
        const watt = specValue(p, 'Wattage');
        if (watt && !parts.includes(watt)) parts.push(watt);
        return parts.length ? parts.join(' — ') : MISSING;
      })(),
    },
    { label: 'Chăm sóc', value: specValue(p, 'Care instructions') ?? specValue(p, 'Care') ?? MISSING },
    { label: 'Biến thể', value: variantText },
    {
      label: 'Listing eBay khớp',
      value: (p.ebayItemTitle ?? p.ebayItemId ?? '').toString().trim()
        ? `${p.ebayItemTitle ?? p.ebayItemId}${p.ebayMatchScore != null ? ` (khớp ${Number(p.ebayMatchScore).toFixed(2)})` : ''}`
        : MISSING,
      url: (p.ebayItemUrl ?? '').toString().trim() || null,
    },
    { label: 'Đã bán (eBay)', value: p.ebaySold != null ? `~${p.ebaySold} (ước tính)` : MISSING },
    { label: 'Người theo dõi', value: p.ebayWatchers != null ? String(p.ebayWatchers) : MISSING },
    { label: 'Mã danh mục', value: categoryId ? `${categoryId}${categoryName ? ` — ${categoryName}` : ''} (tự áp từ eBay)` : MISSING },
  ];
}

/**
 * Chia sản phẩm thành nhóm theo chủ đề, mỗi nhóm xuất 1 file CSV riêng.
 * Thứ tự ưu tiên: (a) categoryId eBay đã chốt; (b) mã danh mục đã xác minh
 * từ eBay Taxonomy (edits.ebayCategoryId — chỉ mã từ Taxonomy hoặc template
 * thật mới được xuất file upload được); (c) nhóm AI đã lưu (edits.aiGroup);
 * (d) theme/product_type do team ghi (cột NGÁCH trong sheet, hoặc
 * "url | chủ đề" khi bulk crawl); (e) từ khoá trong tiêu đề; (f) breadcrumb
 * đầu tiên; (g) Other.
 * Lưu ý: breadcrumb chỉ là fallback sau từ khoá, vì breadcrumb của Soho
 * thường rộng ("Furniture") và sẽ gom hết vào một nhóm, mất ý nghĩa chia.
 */
export function groupProductsByTheme(products) {
  const groups = [];
  const byKey = new Map();
  const push = (key, label, categoryId, product) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, categoryId: categoryId ?? null, products: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.products.push(product);
    return g;
  };
  for (const p of products || []) {
    const catId = p.category_id ?? p.categoryId ?? p.edits?.category_id ?? null;
    if (catId) { push(`cat-${catId}`, `Category ${catId}`, String(catId), p); continue; }
    // Mã danh mục đã xác minh từ eBay Taxonomy (edits.ebayCategoryId, lưu
    // qua POST /api/ebay/resolve-groups + PUT sau khi team bấm chấp nhận):
    // nhóm theo mã đó để xuất file upload được. Mã do AI đoán
    // (edits.draftCategorySuggestion) KHÔNG đi qua đây.
    const ebayCatId = (p.edits?.ebayCategoryId ?? '').toString().trim();
    if (ebayCatId) {
      const label = (p.edits?.ebayCategoryName ?? '').toString().trim()
        || (p.edits?.aiGroupLabel ?? '').toString().trim()
        || `Category ${ebayCatId}`;
      const g = push(`cat-${ebayCatId}`, label, ebayCatId, p);
      if (!g.resolvedCategory) g.resolvedCategory = resolvedCategoryFromEdits(p.edits, ebayCatId);
      continue;
    }
    // Nhóm AI đã lưu (edits.aiGroup, qua POST /api/ai/group + PUT) được
    // ưu tiên trước theme/từ khoá — để lần sau mở lại vẫn còn đúng nhóm
    // AI đã gom, kể cả tên không chứa từ khoá loại ("Dax", "Mayfair").
    // Chỉ nhóm gối có categoryId (20563); nhóm khác null (chưa có template).
    const aiGroup = (p.edits?.aiGroup ?? '').toString().trim();
    if (aiGroup) {
      const key = slugifyTheme(aiGroup) || 'custom';
      const label = (p.edits?.aiGroupLabel ?? '').toString().trim() || aiGroup;
      push(key, label, key === 'cushions' ? '20563' : null, p);
      continue;
    }
    const theme = (p.theme ?? p.product_type ?? '').toString().trim();
    if (theme) {
      // NGÁCH tiếng Việt ("Gối") vẫn gán đúng categoryId (20563) nhưng GIỮ
      // nguyên nhãn team ghi để bảng nhóm hiển thị đúng chữ của team.
      const hit = resolveThemeGroup(theme);
      if (hit) { push(hit.key, theme, hit.categoryId ?? null, p); continue; }
      push(`theme-${slugifyTheme(theme) || 'custom'}`, theme, null, p); continue;
    }
    const hay = `${p.title ?? ''} ${p.title_raw ?? ''}`.toLowerCase();
    const hit = THEME_KEYWORDS.find((t) => t.keywords.some((k) => hay.includes(k)));
    if (hit) { push(hit.key, hit.label, hit.categoryId ?? null, p); continue; }
    const crumb = Array.isArray(p.breadcrumb) && p.breadcrumb[0] ? String(p.breadcrumb[0]).trim() : '';
    if (crumb && !/^home$/i.test(crumb)) { push(`theme-${slugifyTheme(crumb) || 'custom'}`, crumb, null, p); continue; }
    push('other', 'Other', null, p);
  }
  return groups;
}

/**
 * Chia sản phẩm thành nhóm theo kết quả gom nhóm của AI
 * (POST /api/ai/group trả [{productId, groupKey, groupLabel, ebayType}]).
 * Trả nhóm đúng shape của groupProductsByTheme để dùng chung cho xuất CSV.
 * Sản phẩm không có trong assignments -> nhóm "chua-phan-loai" (không xuất,
 * team kiểm lại tay). Chỉ nhóm gối có categoryId (20563); nhóm khác null.
 */
export function groupProductsByAiAssignments(products, assignments) {
  const byId = new Map((assignments ?? []).map((a) => [a.productId, a]));
  const groups = [];
  const byKey = new Map();
  const push = (key, label, categoryId, product) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, categoryId: categoryId ?? null, products: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.products.push(product);
  };
  for (const p of products || []) {
    const a = byId.get(p.id);
    if (!a) { push('chua-phan-loai', 'Chưa phân loại', null, p); continue; }
    const key = slugifyTheme(a.groupKey) || 'chua-phan-loai';
    const label = (a.groupLabel ?? '').toString().trim() || key;
    push(key, label, key === 'cushions' ? '20563' : null, p);
  }
  // Nhóm nào mà mọi sản phẩm đều đã có cùng một mã danh mục xác minh từ
  // eBay Taxonomy (edits.ebayCategoryId, team đã bấm chấp nhận) thì gán
  // mã đó cho nhóm để xuất file upload được; nhóm có nhiều mã khác nhau
  // (không nên xảy ra vì resolve theo nhóm) thì giữ nguyên để file nháp
  // xử lý như cũ, không trộn mã.
  for (const g of groups) {
    const ids = [...new Set(g.products.map((p) => (p.edits?.ebayCategoryId ?? '').toString().trim()).filter(Boolean))];
    if (ids.length === 1) {
      const first = g.products.find((p) => (p.edits?.ebayCategoryId ?? '').toString().trim() === ids[0]);
      g.categoryId = ids[0];
      g.resolvedCategory = resolvedCategoryFromEdits(first?.edits, ids[0]);
    }
  }
  return groups;
}

/**
 * Từ các nhóm (groupProductsByTheme hoặc groupProductsByAiAssignments) xây
 * file CSV cho mỗi nhóm CÓ template khớp categoryId, nhóm chưa có template
 * thì KHÔNG xuất nhầm sang template khác — ghi rõ trong skipped.
 * Nhóm có mã danh mục đã xác minh từ eBay Taxonomy (resolvedCategory với
 * verifiedFromEbay=true) thì xuất file upload được với Category = mã đó,
 * tên file ebay-<categoryId>-<groupKey>.csv — CHỈ mã từ Taxonomy hoặc
 * template thật mới được xuất file upload được, mã do AI đoán thì không.
 * Trả { files: [{filename, groupKey, label, categoryId, csv, productCount,
 *   verifiedFromEbay?, categoryName?, categoryPath?, missingAspects?,
 *   warnings?}], skipped: [{key, label, productCount, reason}] }.
 * Mỗi file chỉ chứa đúng sản phẩm của nhóm đó, không trộn nhóm.
 */
export function buildGroupedEbayCsvs(products, template, config = {}, groups = null) {
  if (!template || !Array.isArray(template.headers)) {
    throw new Error('Cần template eBay đã parse bằng parseEbayTemplate() — template 20563 đã nhúng sẵn trong tool, không cần nạp tay.');
  }
  const list = groups ?? groupProductsByTheme(products);
  const files = [];
  const skipped = [];
  for (const g of list) {
    // Lưới an toàn (v8.3): dữ liệu trong store có thể đã có 2 bản ghi
    // cùng id (chạy 2 lần trước khi sửa lỗi khớp URL) — gộp trước khi
    // xuất để mỗi sản phẩm chỉ 1 dòng, không cần xoá dữ liệu tay.
    const gProducts = listingProductsForGroup(g, template, config, skipped);
    if (!gProducts.length) continue;
    // Template thiếu dòng "For categoryId:" có categoryId null; nhóm chưa
    // có mã cũng null — không được coi null === null là "cùng danh mục".
    const sameAsTemplate = template.categoryId != null && g.categoryId === template.categoryId;
    if (g.resolvedCategory?.aspectSchemaAvailable === false && !sameAsTemplate) {
      skipped.push({ key: g.key, label: g.label, productCount: gProducts.length,
        reason: `Danh mục ${g.categoryId} mới có mã đã lưu, chưa có danh sách trường. Tra Category ID lại trước khi xuất.` });
      continue;
    }
    if (sameAsTemplate) {
      const resolved = g.resolvedCategory?.aspectSchemaAvailable === false ? null : g.resolvedCategory;
      const aspectNames = [...normalizeAspectEntries(resolved?.requiredAspects), ...normalizeAspectEntries(resolved?.recommendedAspects)].map((a) => a.name);
      const csv = buildEbayTemplateCsv(gProducts, template, config, resolved ? { resolvedCategory: { ...resolved, aspectNames } } : {});
      files.push({
        filename: `ebay-${template.categoryId}-${g.key}.csv`,
        groupKey: g.key,
        label: g.label,
        categoryId: g.categoryId,
        csv,
        productCount: gProducts.length,
        ...validateEbayTemplateProducts(gProducts, template, config, resolved, csv),
      });
      continue;
    }
    // Nhóm đã có mã từ Taxonomy (team đã bấm chấp nhận): xuất file upload
    // được, Category = mã đã xác minh, các cột C: điền theo aspect names
    // mà Taxonomy trả về (chỉ điền giá trị đã có; chưa có thì để trống +
    // liệt kê trong missingAspects, không bịa).
    const rc = g.resolvedCategory;
    if (rc?.verifiedFromEbay && g.categoryId) {
      const aspectNames = [
        ...(rc.requiredAspects ?? []).map((a) => (typeof a === 'string' ? a : a?.name)),
        ...(rc.recommendedAspects ?? []).map((a) => (typeof a === 'string' ? a : a?.name)),
      ].map((s) => String(s ?? '').trim()).filter(Boolean);
      // Cảnh báo C:Type (v9.4): Type là trường bắt buộc mà không sản phẩm
      // nào khớp được giá trị cho phép thì C:Type để trống — ghi rõ để
      // team điền tay theo danh sách giá trị eBay trả về, không bịa.
      const warnings = [];
      const typeRequired = normalizeAspectEntries(rc.requiredAspects ?? [])
        .some((a) => a.name.toLowerCase() === 'type');
      if (typeRequired) {
        const unmatched = gProducts.filter((p) => {
          const variants = p?.variants ?? [];
          const variant = variants.filter((v) => v.in_stock)[0] ?? variants[0] ?? {};
          return mapResolvedCategoryType(p, variant, rc) === '';
        });
        if (unmatched.length) {
          warnings.push(`C:Type chưa khớp được cho ${unmatched.length} sản phẩm (${unmatched.slice(0, 3).map((p) => p.title ?? p.id).join('; ')}${unmatched.length > 3 ? '; …' : ''}) — để trống, cần điền tay theo danh sách giá trị eBay trả về cho danh mục này.`);
        }
      }
      const resolvedCategory = { ...rc, categoryId: g.categoryId, aspectNames };
      const csv = buildEbayTemplateCsv(gProducts, template, config, { resolvedCategory });
      const review = validateEbayTemplateProducts(gProducts, template, config, resolvedCategory, csv);
      files.push({
        filename: `ebay-${g.categoryId}-${g.key}.csv`,
        groupKey: g.key,
        label: g.label,
        categoryId: g.categoryId,
        verifiedFromEbay: true,
        categoryName: rc.categoryName ?? null,
        categoryPath: rc.categoryPath ?? null,
        ...review,
        warnings: [...warnings, ...review.warnings],
        csv,
        productCount: gProducts.length,
      });
      continue;
    }
    skipped.push({
      key: g.key,
      label: g.label,
      productCount: gProducts.length,
      reason: g.categoryId
        ? `Nhóm "${g.label}" cần template category ${g.categoryId} — template đang dùng là category ${template.categoryId}, không xuất chung (eBay sẽ từ chối vì thiếu Type).`
        : `Nhóm "${g.label}" chưa có categoryId — gán category_id cho sản phẩm hoặc nạp template của danh mục đó rồi xuất riêng.`,
    });
  }
  return { files, skipped };
}

/** Đối chiếu các ô thực sự được xuất, từng sản phẩm và SKU, với template/Taxonomy.
 * Kết quả là kiểm tra dữ liệu local, không phải xác nhận Seller Hub sẽ nhận file. */
export function validateEbayTemplateProducts(products, template, config = {}, resolved = null, csv = null) {
  const aspectNames = [...normalizeAspectEntries(resolved?.requiredAspects), ...normalizeAspectEntries(resolved?.recommendedAspects)].map((a) => a.name);
  const output = csv ?? buildEbayTemplateCsv(products, template, config, resolved ? { resolvedCategory: { ...resolved, aspectNames } } : {});
  const rows = parseCsvText(output);
  const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell))) ?? template.headers;
  const data = rows.filter((row) => row[templateColumnIndex(headers, 'Action')] === 'Add');
  const required = normalizeAspectEntries(resolved?.requiredAspects ?? template.requiredAspects);
  const recommended = normalizeAspectEntries(resolved?.recommendedAspects);
  const aspects = [...required, ...recommended];
  const requiredNames = new Set(required.map((a) => a.name));
  const issues = [];
  let offset = 0;
  const read = (row, name) => String(row?.[templateColumnIndex(headers, name)] ?? '').trim();
  for (const product of products ?? []) {
    const variants = listingVariants(product);
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[index];
      const row = data[offset++];
      const issue = (field, code, message) => issues.push({ productId: product.id, title: product.edits?.title ?? product.title,
        sku: variant.sku ?? read(row, 'CustomLabel'), variantIndex: index, field, code, message });
      if (!row) { issue('Row', 'missing_row', 'Không tạo được dòng CSV cho biến thể.'); continue; }
      // Ô bắt đầu bằng = + - @ bị Excel chạy như công thức khi seller mở file
      // để kiểm tra. Không tự sửa dữ liệu upload — báo để seller sửa nội dung.
      for (let col = 0; col < headers.length; col++) {
        if (!looksLikeCsvFormula(row[col])) continue;
        const name = String(headers[col] ?? '').replace(/^\*/, '').replace(/\(.*$/, '');
        issue(name, 'csv_formula_like', `Ô ${name} bắt đầu bằng "${String(row[col]).charAt(0)}" — Excel có thể chạy như công thức. Sửa nội dung trước khi mở file bằng Excel hoặc upload.`);
      }
      const priceText = read(row, 'StartPrice');
      if (!priceText || !Number.isFinite(Number(priceText)) || Number(priceText) <= 0) {
        let priceError = null;
        try {
          listingPriceOrThrow(product, variant, config, templateListingCurrency(template, config));
        } catch (error) {
          if (!isListingPriceError(error)) throw error;
          priceError = error;
        }
        issue('StartPrice', priceError?.code ?? 'invalid_listing_price', priceError
          ? `StartPrice để trống. ${priceError.message.replace(/trước khi xuất\./, 'trước khi listing.')}`
          : 'StartPrice phải là giá bán hữu hạn lớn hơn 0; seller cần điền trước khi listing.');
      }
      // Each exported Add row is a standalone SKU listing and needs its own
      // title, description and photos; the first SKU cannot cover later rows.
      for (const field of ['Title', 'Description', 'PicURL']) {
        if (!read(row, field)) issue(field, 'missing_listing_field', `Thiếu ${field}.`);
      }
      if (index === 0) {
        if (product.truncated) issue('Variants', 'incomplete_crawl', 'Lần đọc trang chưa lấy đầy đủ biến thể.');
        if (product.price_estimated) issue('StartPrice', 'estimated_source_price', 'Giá nguồn đang là giá ước tính; cần kiểm tra từng biến thể.');
      }
      const shippingProfile = read(row, 'ShippingProfileName');
      const returnProfile = read(row, 'ReturnProfileName');
      if (!read(row, 'Location')) issue('Location', 'missing_seller_setting', 'Seller cần điền nơi gửi hàng (Location).');
      // An explicit Country column is used by the per-seller export flow.
      // Legacy templates without this column keep their header default.
      if (templateColumnIndex(headers, 'Country') >= 0) {
        const country = read(row, 'Country');
        if (!country) issue('Country', 'missing_seller_setting', 'Seller cần điền mã quốc gia gửi hàng (Country), ví dụ US hoặc VN.');
        else if (!/^[a-z]{2}$/i.test(country)) issue('Country', 'invalid_seller_setting', 'Country phải là mã quốc gia gồm 2 chữ cái.');
      }
      if (!shippingProfile) {
        if (!read(row, 'ShippingService-1:Option') && read(row, 'ShippingType') !== 'Freight') {
          issue('ShippingProfileName', 'missing_seller_setting', 'Seller cần điền tên chính sách vận chuyển (ShippingProfileName) hoặc dịch vụ vận chuyển trong CSV.');
        }
        const handling = read(row, 'DispatchTimeMax');
        if (!handling) issue('DispatchTimeMax', 'missing_seller_setting', 'Seller cần điền thời gian xử lý đơn (DispatchTimeMax), hoặc dùng chính sách vận chuyển.');
        else if (!/^\d+$/.test(handling)) issue('DispatchTimeMax', 'invalid_seller_setting', 'Thời gian xử lý đơn phải là số ngày nguyên không âm.');
      }
      if (!returnProfile) {
        const accepts = read(row, 'ReturnsAcceptedOption');
        if (!accepts) issue('ReturnsAcceptedOption', 'missing_seller_setting', 'Seller cần điền chính sách đổi trả (ReturnsAcceptedOption hoặc ReturnProfileName).');
        else if (!['ReturnsAccepted', 'ReturnsNotAccepted'].includes(accepts)) {
          issue('ReturnsAcceptedOption', 'invalid_seller_setting', 'ReturnsAcceptedOption phải là ReturnsAccepted hoặc ReturnsNotAccepted.');
        }
        // eBay requires the return period and payer when returns are accepted.
        // Supported periods depend on marketplace/category, so don't invent one.
        if (accepts === 'ReturnsAccepted') {
          if (!read(row, 'ReturnsWithinOption')) issue('ReturnsWithinOption', 'missing_seller_setting', 'Seller cần điền thời hạn trả hàng (ReturnsWithinOption) khi chấp nhận đổi trả.');
          const payer = read(row, 'ShippingCostPaidByOption');
          if (!payer) issue('ShippingCostPaidByOption', 'missing_seller_setting', 'Seller cần chọn người trả phí gửi hàng hoàn trả (Buyer hoặc Seller).');
          else if (!['Buyer', 'Seller'].includes(payer)) issue('ShippingCostPaidByOption', 'invalid_seller_setting', 'Người trả phí gửi hàng hoàn trả phải là Buyer hoặc Seller.');
        }
      }
      for (const field of ['ShippingProfileName', 'ReturnProfileName', 'PaymentProfileName']) {
        if (read(row, field).length > 50) issue(field, 'invalid_seller_setting', `${field} vượt 50 ký tự; dùng đúng tên chính sách trong tài khoản seller.`);
      }
      for (const aspect of aspects) {
        const field = `C:${aspect.name}`;
        const value = read(row, field);
        if (!value) {
          if (requiredNames.has(aspect.name)) issue(field, 'missing_required_aspect', `Thiếu trường bắt buộc ${aspect.name}.`);
          continue;
        }
        const constraint = aspect.aspectConstraint ?? {};
        const values = constraint.itemToAspectCardinality === 'MULTI' ? value.split('|').map((v) => v.trim()) : [value];
        if (constraint.aspectMode === 'SELECTION_ONLY' && aspect.values.length
          && values.some((v) => !aspect.values.some((allowed) => allowed.toLowerCase() === v.toLowerCase()))) {
          issue(field, 'invalid_aspect_value', `${aspect.name}: "${value}" không nằm trong giá trị eBay cho phép.`);
        }
        if (Number(constraint.aspectMaxLength) > 0 && values.some((v) => v.length > Number(constraint.aspectMaxLength))) {
          issue(field, 'aspect_too_long', `${aspect.name} vượt ${constraint.aspectMaxLength} ký tự.`);
        }
        if (constraint.aspectDataType === 'NUMBER' && values.some((v) => !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v))) {
          issue(field, 'invalid_aspect_number', `${aspect.name} phải là số theo định dạng eBay.`);
        }
        for (const selected of values) {
          const allowed = aspect.aspectValues?.find((v) => String(v.localizedValue).toLowerCase() === selected.toLowerCase());
          const dependencies = allowed?.valueConstraints ?? [];
          if (dependencies.length && !dependencies.some((dependency) => {
            const control = read(row, `C:${dependency.applicableForLocalizedAspectName}`).split('|');
            return (dependency.applicableForLocalizedAspectValues ?? []).some((v) => control.some((actual) => actual.toLowerCase() === String(v).toLowerCase()));
          })) issue(field, 'aspect_dependency', `${aspect.name}: "${selected}" cần giá trị trường liên quan phù hợp với eBay.`);
        }
      }
    }
  }
  const missingAspects = [...new Set(issues.filter((i) => i.code === 'missing_required_aspect').map((i) => i.field.slice(2)))];
  const warnings = [...new Set(issues.map((i) => `${i.title ?? i.productId}${i.sku ? ` [${i.sku}]` : ''}: ${i.message}`))];
  return { needsReview: issues.length > 0, validationIssues: issues, missingAspects, warnings };
}

// ---- Soho Home helpers (pure, dùng chung core + test) ----------------------
// Trang thật đã kiểm 13/11/2026 (browser.open, không vượt captcha):
// - JSON-LD schema.org/Product: offers.price = GIÁ NON-MEMBER ($1,470 bàn
//   Cavern, $2,450 thảm Catherine 200x200cm), availability InStock.
// - Giá Member rẻ hơn ~20% ($1,176 / $1,960): KHÔNG lấy, chỉ lấy giá thường.
// - "Regular Price $2,095" là giá gốc/compare-at (cao hơn giá hiện tại).
// - Size nằm trong tiêu đề (", 200 x 200cm") hoặc Details & Dimensions.
//   Các size khác của thảm là TRANG SẢN PHẨM RIÊNG (vd 170x240cm có URL
//   riêng, giá riêng) — bulk crawl phải crawl từng URL, không gộp thành
//   biến thể của một trang.

/** Parse "H45 x W50 x D50cm / H18 x W20 x D20\"" -> Item Height/Width/Length dạng "18 in". */
export function parseSohoDimensions(text) {
  const t = String(text ?? '');
  const inch = t.match(/H([\d.]+)\s*x\s*W([\d.]+)\s*x\s*D([\d.]+)\s*(?:"|in)/i);
  if (inch) {
    return {
      dimensions: t.trim(),
      itemHeight: `${trimNum(inch[1])} in`,
      itemWidth: `${trimNum(inch[2])} in`,
      itemLength: `${trimNum(inch[3])} in`,
    };
  }
  const cm = t.match(/H([\d.]+)\s*x\s*W([\d.]+)\s*x\s*D([\d.]+)\s*cm/i);
  if (cm) {
    const toIn = (v) => trimNum(String(Math.round(Number(v) / 2.54 * 10) / 10));
    return {
      dimensions: t.trim(),
      itemHeight: `${toIn(cm[1])} in`,
      itemWidth: `${toIn(cm[2])} in`,
      itemLength: `${toIn(cm[3])} in`,
    };
  }
  return { dimensions: t.trim() || null, itemHeight: null, itemWidth: null, itemLength: null };
}

function trimNum(s) {
  const n = Number(s);
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Preserve the stated precision: "6.7kg / 14.8lbs" -> "14.8 lb". */
export function parseSohoWeight(text) {
  const t = String(text ?? '');
  // Decimal dot/comma are both used on source pages. Do not start a new
  // match inside a malformed or negative number (e.g. 14.8.2 or -14.8).
  const m = t.match(/(?:^|[^\d.,+-])(\d+(?:[.,]\d+)?)\s*lbs?\b/i);
  if (m) return `${Number(m[1].replace(',', '.'))} lb`;
  return null;
}

// ---- Số liệu eBay (v9.1, TỰ ĐỘNG qua Browse API) --------------------------
// Tool tự tìm listing eBay khớp theo tên + giá (search + getItem), lấy
// watchCount (số người theo dõi) và estimatedSoldQuantity (số đã bán ƯỚC
// TÍNH — eBay nói rõ đây là ước tính, không phải số chính xác tuyệt đối).
// Số liệu là TỔNG cả listing, không chia theo màu/size — eBay không công
// bố số theo biến thể ở bất kỳ nguồn công khai nào. KHÔNG cào WatchCount
// (robots.txt của họ cấm bot, không có API công khai).
// "X sold" công khai trên trang listing eBay vẫn đọc được bằng
// parseEbaySoldCount (extension giữ EXTRACT_EBAY_SOLD làm dự phòng khi
// Browse API không trả số đã bán cho listing đó).

/**
 * Đọc số đã bán từ text trang listing eBay: "1,234 sold" -> 1234,
 * "12 sold" -> 12, "1.234 sold" (dấu chấm hàng nghìn) -> 1234.
 * Không có "N sold" thì null — KHÔNG bịa số.
 */
export function parseEbaySoldCount(text) {
  const m = String(text ?? '').match(/([\d][\d.,]*)\s*sold\b/i);
  if (!m) return null;
  let num = m[1].replace(/\s+/g, '');
  if (/,/.test(num)) num = num.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, '');
  const n = Number(num);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Lấy mã số item eBay từ link listing: /itm/<tên>/<id>, /itm/<id>, ?item=<id>. */
export function parseEbayItemId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d{9,}$/.test(s)) return s; // Dán thẳng mã số item.
  let url = null;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/ebay\./i.test(url.hostname)) return null;
  const itemParam = url.searchParams.get('item');
  if (itemParam && /^\d{9,}$/.test(itemParam)) return itemParam;
  const parts = url.pathname.split('/').filter(Boolean);
  const itmIdx = parts.findIndex((p) => p.toLowerCase() === 'itm');
  const candidates = itmIdx >= 0 ? parts.slice(itmIdx + 1) : parts;
  const id = candidates.find((p) => /^\d{9,}$/.test(p));
  return id ?? null;
}

/** Số người theo dõi sửa tay khi cần (vd Browse API không trả watchCount):
 *  số nguyên >= 0, khác thì null. */
export function parseEbayWatchers(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Mã sản phẩm (source_product_id) suy từ URL khi extension không gửi kèm:
 *  đoạn sau "products" (vd /us/products/daxton-square-cushion/79996850 ->
 *  "daxton-square-cushion-79996850"), không có thì đoạn cuối đường dẫn.
 *  Không suy được thì null. */
export function sourceProductIdFromUrl(url) {
  let u = null;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  const parts = u.pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (!parts.length) return null;
  const last = parts[parts.length - 1].replace(/\.(html?|php)$/i, '');
  if (!last) return null;
  const prodIdx = parts.findIndex((p) => p.toLowerCase() === 'products');
  if (prodIdx >= 0 && parts.length > prodIdx + 1) return parts.slice(prodIdx + 1).join('-');
  return last;
}

// ---- File research (v9.1): số liệu tham khảo cho seller, KHÔNG phải file
// upload Seller Hub. 1 file riêng cho mỗi nhóm: research-<groupKey>.csv.
// Cột: Title, URL gốc, Giá bán lẻ, Giá bán eBay (GIÁ BÁN), Đã bán,
// Người theo dõi, CategoryId, Link listing eBay, Điểm khớp. Đã bán (ước
// tính) / Người theo dõi là TỔNG cả listing eBay, không chia theo màu/size;
// trống khi chưa có số liệu / chưa khớp listing.

export const RESEARCH_CSV_HEADERS = ['Title', 'URL gốc', 'Giá bán lẻ', 'Giá bán eBay (GIÁ BÁN)', 'Đã bán', 'Người theo dõi', 'CategoryId', 'Link listing eBay', 'Điểm khớp'];

export function researchRowForProduct(p, config = {}) {
  const eff = applyEdits(p, config);
  const categoryId = p.edits?.ebayCategoryId ?? p.edits?.categoryId ?? p.category_id ?? p.category ?? '';
  return [
    p.edits?.title ?? p.title ?? '',
    p.source_url ?? '',
    p.price != null ? Number(p.price).toFixed(2) : '',
    eff.sell_price != null ? Number(eff.sell_price).toFixed(2) : '',
    p.ebaySold != null ? String(p.ebaySold) : '',
    p.ebayWatchers != null ? String(p.ebayWatchers) : '',
    categoryId ? String(categoryId) : '',
    p.ebayItemUrl ?? '',
    p.ebayMatchScore != null ? Number(p.ebayMatchScore).toFixed(2) : '',
  ];
}

export function buildResearchCsv(products, config = {}) {
  const rows = [RESEARCH_CSV_HEADERS];
  for (const p of products ?? []) rows.push(researchRowForProduct(p, config));
  // File research chỉ để mở bằng Excel: tiêu đề listing eBay do seller khác
  // đặt (ebayItemTitle) có thể là "=HYPERLINK(...)" -> vô hiệu hoá công thức.
  return serializeCsvRows(rows, { neutralizeFormulas: true });
}

/**
 * 1 file research riêng cho mỗi nhóm (nhóm theo groupProductsByTheme hoặc
 * groups truyền vào — cùng nhóm dùng cho xuất CSV upload). Nhóm "chua-phan-
 * loai"/"other" vẫn có file research (chỉ để xem, không xuất upload).
 * Trả {files: [{groupKey, label, filename, csv, productCount}], skipped}.
 */
export function buildResearchGroupedCsvs(products, config = {}, groups = null) {
  const list = (products ?? []).filter(Boolean);
  const gs = groups ?? groupProductsByTheme(list);
  const files = [];
  const skipped = [];
  for (const g of gs ?? []) {
    const members = (g.products ?? []).filter(Boolean);
    if (!members.length) { skipped.push({ key: g.key, label: g.label, productCount: 0, reason: 'nhóm không có sản phẩm' }); continue; }
    files.push({
      groupKey: g.key,
      label: g.label,
      filename: `research-${g.key}.csv`,
      csv: buildResearchCsv(members, config),
      productCount: members.length,
    });
  }
  return { files, skipped };
}

// ---- Bulk list: dán danh sách link / xuất sheet ra CSV ---------------------

/**
 * Parse danh sách link dán tay, mỗi dòng 1 URL, kèm chủ đề tùy chọn:
 *   https://www.sohohome.com/us/products/cavern-side-table | Bàn ghế
 *   https://www.sohohome.com/us/products/catherine-rug-navy-round
 * Trả { items: [{url, theme}], invalid: [dòng lỗi] }. Trùng URL thì giữ dòng đầu.
 */
export function parseBulkList(text) {
  const items = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [urlPart, ...themeParts] = line.split('|');
    const url = urlPart.trim().replace(/^["']|["']$/g, '');
    const theme = themeParts.join('|').trim() || null;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      invalid.push(line);
      continue;
    }
    if (seen.has(url)) continue; // Trùng URL: bỏ qua lặng lẽ, không tính là lỗi.
    seen.add(url);
    items.push({ url, theme });
  }
  return { items, invalid };
}

/**
 * Parse ô tiền trong sheet. Sheet Sabo_Lucky_Rate 9 dùng định dạng châu Âu:
 * "$395,00" = 395.00 USD, "$1.295,00" = 1295.00 USD (dấu . là nghìn,
 * dấu , là thập phân), "$0,49" = 0.49 USD. Định dạng Mỹ "$1,295.00" cũng
 * phải đọc đúng. Cách cũ (xoá hết dấu ,) đọc sai: "$395,00" thành 39500,
 * "$1.295,00" thành 1.295 — KHÔNG dùng nữa.
 */
export function parseMoneyCell(cell) {
  let s = String(cell ?? '').replace(/[$€£\s\u00a0]/g, '').trim();
  if (!s || !/\d/.test(s)) return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // Dấu nào đứng sau thì là thập phân: "1.295,00" (EU) vs "1,295.00" (US).
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // Chỉ có dấu phẩy: "395,00" (EU, 2 chữ số thập phân) hoặc "1,295" (US nghìn).
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length === 2) s = `${parts[0]}.${parts[1]}`;
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse file CSV xuất từ sheet (vd Sabo_Lucky_Rate 9, tab Soho Home).
 * Tự tìm cột link (header chứa EBAY/Site/Link/URL) và cột chủ đề (TYPE/NGÁCH),
 * cột tiêu đề (TITLE) và cột giá nguồn (COST). Trả { items, invalid } với
 * item = { url, theme, type, title, brand, cost, description, size,
 *   title_hint, cost_hint, source_row }.
 * Ưu tiên link theo từng dòng: (1) cột EBAY, (2) cột "Site chính",
 * (3) bất kỳ ô nào trong dòng chứa URL sản phẩm — vì trong sheet Soho Home
 * có dòng link chỉ nằm ở cột Site chính, cột EBAY để trống.
 * source_row = số dòng trong file CSV (dòng header = 1, tính theo file).
 * Ảnh chụp sheet bị cắt URL nên không trích được link từ ảnh — phải xuất
 * sheet ra CSV rồi dùng hàm này.
 */
export function parseSheetCsv(csvText) {
  const rows = parseCsvText(csvText);
  if (!rows.length) return { items: [], invalid: [] };
  const headerIdx = rows.findIndex((r) => r.some((c) => /ebay|site chính|link|url/i.test(c ?? '')));
  if (headerIdx === -1) {
    const bulk = parseBulkList(csvText);
    return { items: bulk.items.map((it, i) => ({ ...it, title: null, brand: null, cost: null, gia_ban: null, sell_price: null, type: null, description: null, size: null, title_hint: null, cost_hint: null, source_row: i + 1 })), invalid: bulk.invalid };
  }
  const header = rows[headerIdx].map((c) => String(c ?? ''));
  const findCol = (re) => header.findIndex((c) => re.test(c));
  const urlCol = findCol(/ebay/i);
  const siteCol = findCol(/site chính/i);
  const typeCol = findCol(/^\s*type\s*$/i);
  const titleCol = findCol(/title/i);
  const brandCol = findCol(/brand|ngách/i);
  const costCol = findCol(/^\s*cost\s*$/i);
  const giaBanCol = findCol(/giá bán/i);
  const descCol = findCol(/description/i);
  const sizeCol = findCol(/^\s*size\s*$/i);
  const cell = (r, col) => (col >= 0 ? String(r[col] ?? '').trim() : '');
  const urlIn = (s) => {
    const m = String(s ?? '').match(/https?:\/\/[^\s"']+/i);
    return m ? m[0].replace(/[),.]+$/, '') : null;
  };
  const items = [];
  const invalid = [];
  const seen = new Set();
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const sourceRow = headerIdx + i + 2; // 1-based, dòng header = headerIdx+1
    // (1) cột EBAY, (2) cột Site chính, (3) quét mọi ô trong dòng.
    const url = urlIn(cell(r, urlCol)) ?? urlIn(cell(r, siteCol)) ??
      r.map((c) => urlIn(c)).find(Boolean) ?? null;
    if (!url) return; // Dòng trống / không có link: bỏ qua lặng lẽ, không tính lỗi.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      invalid.push(url);
      return;
    }
    // Trùng URL (kể cả khác nhau ở dấu "/" cuối hay "www."): giữ dòng đầu.
    const urlKey = normalizeProductUrl(url);
    if (seen.has(urlKey)) return;
    seen.add(urlKey);
    const type = cell(r, typeCol) || null;
    const title = cell(r, titleCol) || null;
    const cost = parseMoneyCell(cell(r, costCol));
    // GIÁ BÁN trong sheet là giá bán eBay đã chốt (vd Daxton COST $395
    // nhưng GIÁ BÁN $280 — thấp hơn COST). Luồng tự động dùng GIÁ BÁN
    // làm StartPrice khi có; chỉ tính lại bằng calcSellPrice khi sheet
    // không có GIÁ BÁN. Không ghi đè GIÁ BÁN bằng công thức mặc định.
    const giaBan = parseMoneyCell(cell(r, giaBanCol));
    items.push({
      url,
      // theme = TYPE nếu có, để groupProductsByTheme ưu tiên đúng NGÁCH team ghi.
      theme: type,
      type,
      title,
      brand: cell(r, brandCol) || null,
      cost,
      gia_ban: giaBan,
      sell_price: giaBan,
      description: cell(r, descCol) || null,
      size: cell(r, sizeCol) || null,
      title_hint: title,
      cost_hint: cost,
      source_row: sourceRow,
    });
  });
  return { items, invalid };
}

// ---- Google Sheet: dán link là tự lấy link --------------------------------
// Link trong ảnh chụp (ID đọc từ ảnh, gid 852166301) đã thử fetch ngày
// 13/11/2026: Google trả HTTP 404 + trang HTML "Không tìm thấy trang /
// tệp không tồn tại" — không phải trang đăng nhập. Nghĩa là hoặc ID đọc
// từ ảnh bị sai ký tự, hoặc sheet chưa chia sẻ công khai. Các hàm dưới
// đây báo rõ từng trường hợp, không im lặng, và hướng dẫn user sửa.

// ---- Xuất CSV theo template eBay -------------------------------------------

/** Lọc mô tả HTML cho eBay: bỏ script/style/iframe/form, bỏ link ngoài (giữ chữ), bỏ ảnh trong mô tả (ảnh đã ở PicURL). */
export function sanitizeEbayDescription(html) {
  let s = String(html ?? '');
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, '');
  s = s.replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, '');
  s = s.replace(/<(form|input|button|link|meta|object|embed)[^>]*\/?>/gi, '');
  s = s.replace(/<img[^>]*>/gi, '');
  s = s.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, '$1');
  s = s.replace(/href\s*=\s*["']\s*javascript:[^"']*["']/gi, '');
  return s.trim();
}

/** Tìm vị trí cột trong header template (bỏ dấu * đầu, "*Action(...)" -> Action). */
export function templateColumnIndex(headers, name) {
  const norm = (h) => String(h ?? '').replace(/^\*/, '').replace(/\(.*$/, '').trim().toLowerCase();
  const idx = headers.findIndex((h) => norm(h) === norm(name));
  if (idx >= 0) return idx;
  return -1;
}

/**
 * Khớp giá trị Type dài nhất có trong tiêu đề / product_type / theme
 * (vd "Throw Pillow", "Table Lamp") với danh sách giá trị cho phép cho
 * trước. Giá trị team đã duyệt (edits.ebayType) được ưu tiên — chỉ khi
 * nó nằm trong danh sách cho phép. Không khớp được thì trả '' để team
 * điền — KHÔNG bịa giá trị.
 */
export function matchTypeValue(product, values) {
  const list = [...new Set((values ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))];
  if (!list.length) return '';
  const approved = product.edits?.ebayType;
  if (approved && list.includes(approved)) return approved;
  const hay = `${product.title ?? ''} ${product.title_raw ?? ''} ${product.product_type ?? ''} ${product.theme ?? ''}`.toLowerCase();
  const sorted = [...list].sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    if (v && hay.includes(v.toLowerCase())) return v;
  }
  return '';
}

/**
 * Map *C:Type: khớp giá trị gợi ý dài nhất có trong tiêu đề / product_type /
 * theme (vd "Throw Pillow", "Lumbar Pillow"). Không khớp được thì để trống
 * để team điền — KHÔNG bịa giá trị.
 */
export function mapEbayType(product, template) {
  const values = template?.recommendedValues?.Type ?? [];
  if (!values.length) return '';
  // Giá trị team đã duyệt (vd bấm "Áp dụng" trên gợi ý AI) được ưu tiên —
  // chỉ khi nó nằm trong danh sách cho phép của template.
  const approved = product.edits?.ebayType;
  if (approved && values.includes(approved)) return approved;
  const hay = `${product.title ?? ''} ${product.title_raw ?? ''} ${product.product_type ?? ''} ${product.theme ?? ''}`.toLowerCase();
  // NGÁCH tiếng Việt trong sheet: "Gối" -> Throw Pillow, "Gối ôm" -> Bolster.
  if (/gối ôm|goi om/.test(hay) && values.includes('Bolster')) return 'Bolster';
  if (/gối|goi/.test(hay) && values.includes('Throw Pillow')) return 'Throw Pillow';
  // Sham = vỏ gối trang trí -> Pillow Cover (giá trị cho phép gần nhất).
  if (/\bsham\b/.test(hay) && values.includes('Pillow Cover')) return 'Pillow Cover';
  return matchTypeValue(product, values);
}

/**
 * Danh sách giá trị cho phép của aspect "Type" trong danh mục đã tra mã
 * từ Taxonomy (resolved.requiredAspects + recommendedAspects, dạng
 * {name, values[]} do getItemAspects trả về). Không có giá trị nào thì
 * trả [] — lúc đó C:Type không khớp theo danh sách được.
 */
export function resolvedTypeValues(resolved) {
  const entries = [
    ...normalizeAspectEntries(resolved?.requiredAspects),
    ...normalizeAspectEntries(resolved?.recommendedAspects),
  ];
  const values = [];
  for (const e of entries) {
    if (String(e.name ?? '').trim().toLowerCase() === 'type') values.push(...(e.values ?? []));
  }
  return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

/**
 * Map C:Type cho danh mục đã có mã từ Taxonomy (v9.4 — sửa lỗi C:Type luôn
 * trống ở mọi danh mục khác gối): trước đây đường xuất bỏ qua mapEbayType
 * (chỉ khớp 22 giá trị của template gối 20563) và điền Type qua
 * aspectFromProduct, mà AI trích xuất + reader trang đều không sinh trường
 * Type nên luôn trống. Giờ khớp theo danh sách giá trị cho phép của chính
 * danh mục đó (Taxonomy trả về qua getItemAspects):
 *  1. edits.ebayType team đã duyệt — chỉ khi nằm trong danh sách cho phép;
 *  2. Type từ dữ liệu sản phẩm (aiSpecifics đã duyệt / attrs / specs) —
 *     chỉ khi nằm trong danh sách cho phép;
 *  3. giá trị dài nhất có trong tiêu đề / product_type / theme.
 * Không khớp được giá trị nào trong danh sách thì trả '' để trống, không
 * bịa. NGOẠI LỆ: khi Taxonomy không trả giá trị cho phép cho Type (dữ liệu
 * cũ lưu dạng tên-only, hoặc eBay không liệt kê values) thì giữ hành vi cũ:
 * lấy Type từ dữ liệu sản phẩm (bước 2, không có danh sách để kiểm chứng).
 */
export function mapResolvedCategoryType(product, variant, resolved) {
  const values = resolvedTypeValues(resolved);
  const approved = product.edits?.ebayType;
  const typeAspect = [...normalizeAspectEntries(resolved?.requiredAspects), ...normalizeAspectEntries(resolved?.recommendedAspects)]
    .find((a) => a.name.toLowerCase() === 'type');
  if (typeAspect?.aspectConstraint?.aspectMode === 'FREE_TEXT') {
    const source = approved || aspectFromProduct(product, variant ?? {}, 'Type');
    if (source) return source;
  }
  if (approved && values.includes(approved)) return approved;
  const fromProduct = aspectFromProduct(product, variant ?? {}, 'Type');
  if (fromProduct && values.includes(fromProduct)) return fromProduct;
  const matched = matchTypeValue(product, values);
  if (matched) return matched;
  if (!values.length) return fromProduct ?? '';
  return '';
}

function aspectFromProduct(product, variant, name) {
  // Item specifics team đã duyệt từ gợi ý AI (edits.aiSpecifics) được ưu
  // tiên — chỉ khi có giá trị thật, không ghi đè bằng dữ liệu trang.
  const approvedFields = product.edits?.aiSpecifics ?? {};
  const approvedKey = Object.keys(approvedFields).find((key) => key.toLowerCase() === name.toLowerCase());
  const approved = approvedKey ? approvedFields[approvedKey] : null;
  if (approved != null && String(approved).trim() !== '') return String(approved).trim();
  const attrs = product.attributes ?? {};
  const specs = product.specs ?? {};
  const findKey = (obj, re) => {
    const k = Object.keys(obj).find((x) => re.test(x));
    return k ? obj[k] : null;
  };
  const cleanVal = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const optionKey = Object.keys(variant.options ?? {}).find((key) => key.toLowerCase() === name.toLowerCase());
  if (optionKey && cleanVal(variant.options[optionKey])) return cleanVal(variant.options[optionKey]);
  switch (name) {
    case 'Brand': return cleanVal(product.brand);
    case 'Color': return cleanVal(variant.options?.Color) ?? cleanVal(findKey(attrs, /^colou?r$/i));
    case 'Size': return cleanVal(variant.options?.Size) ?? cleanVal(findKey(specs, /^size$/i)) ?? cleanVal(findKey(attrs, /^size$/i));
    case 'Material': return cleanVal(findKey(attrs, /^material$/i)) ?? cleanVal(findKey(specs, /^material$/i));
    case 'Department': return cleanVal(product.department);
    case 'Country of Origin': return cleanVal(findKey(attrs, /country|origin/i));
    case 'Fill Material': return cleanVal(findKey(specs, /fill/i)) ?? cleanVal(findKey(attrs, /fill/i));
    case 'Closure Type': return cleanVal(findKey(specs, /closure/i));
    case 'Care Instructions': return cleanVal(findKey(specs, /care/i)) ?? cleanVal(findKey(attrs, /^care/i));
    case 'Theme': return cleanVal(findKey(attrs, /^theme$/i)) ?? cleanVal(product.theme);
    case 'Style': return cleanVal(findKey(attrs, /^style$/i)) ?? cleanVal(findKey(specs, /^style$/i));
    case 'Pattern': return cleanVal(findKey(attrs, /^pattern$/i));
    case 'Shape': return cleanVal(findKey(attrs, /^shape$/i));
    case 'Features': return cleanVal(findKey(attrs, /^features?$/i)) ?? cleanVal(findKey(specs, /^features?$/i))
      ?? (/^yes$/i.test(String(findKey(specs, /^dimmable$/i) ?? '').trim()) ? 'Dimmable' : null);
    case 'Lighting Technology': {
      const explicit = cleanVal(findKey(attrs, /^lighting technology$/i)) ?? cleanVal(findKey(specs, /^lighting technology$/i));
      if (explicit) return explicit;
      const bulbStyle = String(findKey(specs, /^bulb style$/i) ?? '').replace(/\s+/g, ' ').trim();
      return /\bLED$/i.test(bulbStyle) && !/\b(?:non|not|no|without)\b/i.test(bulbStyle) ? 'LED' : null;
    }
    case 'Labels & Certifications': return cleanVal(findKey(attrs, /^labels & certifications$/i)) ?? cleanVal(findKey(specs, /^labels & certifications$/i))
      ?? cleanVal(findKey(specs, /^lighting certification us$/i));
    case 'Subject': return cleanVal(findKey(attrs, /^subject$/i));
    case 'Room': return cleanVal(findKey(attrs, /^room$/i));
    default: return cleanVal(findKey(attrs, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))) ?? cleanVal(findKey(specs, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')));
  }
}

function roomFromProduct(product, template) {
  const hay = `${product.title ?? ''} ${(product.breadcrumb ?? []).join(' ')} ${product.theme ?? ''}`.toLowerCase();
  const rooms = template?.recommendedValues?.Room ?? [];
  const known = ['bedroom', 'living room', 'dining room', 'nursery', 'bathroom', 'kitchen', 'office', 'guestroom'];
  for (const r of known) {
    if (hay.includes(r)) {
      const match = rooms.find((x) => x.toLowerCase() === r) ?? rooms.find((x) => x.toLowerCase().includes(r));
      if (match) return match;
      if (!rooms.length) return r.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

/**
 * Xuất CSV đúng template eBay (File Exchange): giữ nguyên dòng Info Version,
 * dòng header y hệt template, các dòng Info gợi ý sau header, rồi các dòng
 * sản phẩm (1 dòng / biến thể còn hàng, tối đa 250). Cột nào không có dữ
 * liệu thì để trống để team điền, KHÔNG bịa.
 * Mặc định Shipping/Return/Payment Profile lấy từ config (mặc định trống):
 * team PHẢI điền profile trước khi upload (xem README).
 * NGOẠI LỆ (v8.1): file NHÁP (opts.draft) KHÔNG giữ các dòng Info của
 * template mẫu — chỉ có dòng Version, dòng header, ĐÚNG 1 dòng cảnh báo
 * DRAFT ngay dưới header, rồi các dòng dữ liệu (xem DRAFT_WARNING_TEXT).
 */

// ---- File CSV NHÁP (v8.1) ----------------------------------------------------
// v7 đã lỡ để nguyên khối dòng Info của template gối 20563 trong file nháp
// ("For categoryId: 20563", "required aspects are Type; Brand", danh sách
// giá trị gợi ý của gối) — khiến team tưởng đó là mã/danh mục thật của
// nhóm đèn/gương. File nháp chỉ gồm: dòng Version, dòng header, ĐÚNG 1
// dòng cảnh báo DRAFT ngay dưới header, rồi các dòng dữ liệu. Nội dung
// cảnh báo KHÔNG chứa "20563" hay tên aspect nào của gối.
export const DRAFT_WARNING_TEXT = 'DRAFT — File nháp, chưa có mã danh mục eBay nên chưa upload được lên Seller Hub. Cột Category và các cột C: đang trống, cần điền sau khi tra mã từ eBay Taxonomy (bản v8) hoặc template thật của danh mục này.';

/** Dòng cảnh báo duy nhất trong file nháp: ô đầu ghi DRAFT, ô thứ hai là nội dung cảnh báo. */
function draftWarningRow(length) {
  const row = new Array(length).fill('');
  row[0] = 'DRAFT';
  row[1] = DRAFT_WARNING_TEXT;
  return row;
}

/** Chuẩn hoá aspect từ Taxonomy thành {name, values[]} — nhận chuỗi ('Type')
 *  hoặc object ({name, values}) từ getItemAspects. */
function normalizeAspectEntries(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (typeof a === 'string') {
      if (a.trim()) out.push({ name: a.trim(), values: [] });
      continue;
    }
    const name = String(a?.name ?? '').trim();
    if (!name) continue;
    const values = [...new Set((Array.isArray(a?.values) ? a.values : []).map((v) => String(v ?? '').trim()).filter(Boolean))];
    out.push({ name, values,
      ...(a.aspectConstraint && typeof a.aspectConstraint === 'object' ? { aspectConstraint: { ...a.aspectConstraint } } : {}),
      ...(Array.isArray(a.aspectValues) ? { aspectValues: a.aspectValues } : {}),
    });
  }
  return out;
}

/** Một dòng Info trong file CSV File Exchange: ô đầu 'Info', ô thứ hai là nội dung. */
function resolvedCategoryInfoRow(length, text) {
  const row = new Array(length).fill('');
  row[0] = 'Info';
  row[1] = text;
  return row;
}

/**
 * Khối Info ĐÚNG cho file upload được của nhóm đã tra mã từ eBay Taxonomy
 * (v8.2) — thay thế các dòng Info của template gối 20563 (chúng mang mã
 * 20563 + aspect của gối, sai danh mục của nhóm — đúng kiểu lỗi file nháp
 * ở v8.1, chỉ khác là ở file upload được). Định dạng theo template thật:
 * "For categoryId: <mã>", "The required aspects are <tên nối bằng '; '>",
 * "The recommended value(s) for aspect <tên>: <giá trị nối bằng '; '>".
 * - Có requiredAspects (dù rỗng): ghi dòng required aspects, rỗng thì ghi
 *   "(not provided by Taxonomy response)".
 * - Không có dữ liệu aspects nào (cả required lẫn recommended đều không
 *   truyền vào): chỉ giữ dòng categoryId + 1 dòng ghi chú.
 * Lưu ý: dùng đúng 1 khoảng trắng sau "categoryId:" (khác template thật
 * ghi 2 khoảng) để chuỗi "For categoryId: <mã>" tìm được chính xác.
 */
function resolvedCategoryInfoRows(resolved, length) {
  const id = String(resolved?.categoryId ?? '').trim();
  const rows = [resolvedCategoryInfoRow(length, `>>> For categoryId: ${id}`)];
  const hasAspects = resolved?.requiredAspects != null || resolved?.recommendedAspects != null;
  if (!hasAspects) {
    rows.push(resolvedCategoryInfoRow(length, '>>> Aspects for this category were resolved via eBay Taxonomy; see the category page for required aspects'));
    return rows;
  }
  const required = normalizeAspectEntries(resolved.requiredAspects);
  const recommended = normalizeAspectEntries(resolved.recommendedAspects);
  rows.push(resolvedCategoryInfoRow(length, required.length
    ? `>>> The required aspects are ${required.map((a) => a.name).join('; ')}`
    : '>>> The required aspects are (not provided by Taxonomy response)'));
  // Giá trị gợi ý cho từng aspect (khi Taxonomy trả aspectValues) — gộp
  // theo tên để không trùng dòng khi một aspect vừa required vừa recommended.
  const byName = new Map();
  for (const a of [...required, ...recommended]) {
    if (!a.values.length) continue;
    const prev = byName.get(a.name) ?? [];
    byName.set(a.name, [...new Set([...prev, ...a.values])]);
  }
  for (const [name, values] of byName) {
    // CSV hints stay short; full values/constraints are retained in the runtime.
    // Mark shortened lists as previews so parseEbayTemplate cannot mistake them
    // for the category's complete allowed-value list when a CSV is reopened.
    const shown = [];
    let chars = 0;
    for (const value of values) {
      if (shown.length >= 12 || chars + value.length + 2 > 800) break;
      shown.push(value);
      chars += value.length + 2;
    }
    const omitted = values.length - shown.length;
    const hint = omitted
      ? `>>> Preview recommended values for aspect ${name}: ${shown.join('; ') || '(none shown)'}. ${omitted} additional value(s) omitted; full rules remain in tool.`
      : `>>> The recommended value(s) for aspect ${name}: ${shown.join('; ')}`;
    rows.push(resolvedCategoryInfoRow(length, hint));
  }
  return rows;
}

export function buildEbayTemplateCsv(products, template, config = {}, opts = {}) {
  if (!template || !Array.isArray(template.headers) || !template.headers.length) {
    throw new Error('Cần template eBay đã parse bằng parseEbayTemplate().');
  }
  // Nhóm đã có mã từ Taxonomy (opts.resolvedCategory, v8): Category ghi mã
  // đã xác minh thay cho categoryId của template mẫu; các cột C: thêm vào
  // header cho những aspect eBay trả về mà template mẫu không có (vd đèn
  // cần "C:Bulb Type" — cột này không có trong 98 cột của template gối).
  // C:Type của gối (22 giá trị cho phép của template 20563) KHÔNG dùng cho
  // danh mục khác — danh mục đã có mã từ Taxonomy thì khớp Type theo danh
  // sách giá trị cho phép của chính danh mục đó (v9.4,
  // mapResolvedCategoryType); chỉ điền giá trị nằm trong danh sách, không bịa.
  const resolved = opts?.resolvedCategory ?? null;
  if (resolved?.aspectSchemaAvailable === false) throw new Error('Chưa có danh sách trường của danh mục đã lưu. Tra Category ID lại trước khi xuất.');
  const useResolvedType = resolved && (String(resolved.categoryId) !== String(template.categoryId) || resolved.requiredAspects != null);
  const hasCategoryAspects = resolved && (Array.isArray(resolved.requiredAspects) || Array.isArray(resolved.recommendedAspects));
  const categoryAspects = hasCategoryAspects
    ? [...normalizeAspectEntries(resolved.requiredAspects), ...normalizeAspectEntries(resolved.recommendedAspects)] : [];
  const categoryNames = new Set(categoryAspects.map((a) => a.name.toLowerCase()));
  const extraAspectNames = [...new Set((hasCategoryAspects ? categoryAspects.map((a) => a.name) : resolved?.aspectNames ?? [])
    .map((s) => String(s ?? '').trim()).filter(Boolean))];
  // Source options become item specifics for these independent SKU listings.
  // Preserve the third option even when it was not present in the base template.
  for (const name of hasCategoryAspects ? [] : optionNamesFor((products ?? []).flatMap((p) => listingVariants(p)))) {
    const existingHeader = template.headers.find((h) => String(h).replace(/^\*/, '').toLowerCase() === `c:${name.toLowerCase()}`);
    const canonicalName = existingHeader ? String(existingHeader).replace(/^\*?C:/i, '') : name;
    if (!extraAspectNames.some((existing) => existing.toLowerCase() === canonicalName.toLowerCase())) extraAspectNames.push(canonicalName);
  }
  const headers = template.headers.filter((h) => !hasCategoryAspects
    || !/^\*?C:/i.test(h)
    || categoryNames.has(String(h).replace(/^\*?C:/i, '').toLowerCase()));
  const listingCurrency = templateListingCurrency(template, config);
  const normCol = (h) => String(h ?? '').replace(/^\*/, '').trim();
  const explicitCountry = Object.prototype.hasOwnProperty.call(config, 'ebayCountry');
  const country = String(config.ebayCountry ?? '').trim().toUpperCase();
  if (explicitCountry) {
    // A blank seller-specific country must not silently inherit Country=US.
    // Keep the marketplace/currency defaults and leave origin for the seller.
    for (let i = 0; i < headers.length; i++) {
      headers[i] = headers[i].replace(/(\bAction\()([^)]*)(\))/i, (_match, start, values, end) =>
        start + values.split('|').filter((value) => !/^Country\s*=/i.test(value.trim())).join('|') + end);
    }
    const countryIndex = headers.findIndex((h) => normCol(h).toLowerCase() === 'country');
    if (countryIndex >= 0) headers[countryIndex] = 'Country';
    else headers.push('Country');
  }
  for (const name of extraAspectNames) {
    if (!headers.some((h) => normCol(h).toLowerCase() === `c:${name.toLowerCase()}`)) headers.push(`C:${name}`);
  }
  const col = (name) => templateColumnIndex(headers, name);
  // Chế độ nháp (v7, opts.draft): Category và TOÀN BỘ cột C: (item specifics
  // riêng của danh mục trong template) đều để trống — vì file nháp dùng
  // template gối 20563 làm mẫu cột, còn danh mục thật của nhóm chưa biết.
  // Ghi C:Type hay Brand của gối vào file đèn/gương là bịa dữ liệu, eBay
  // sẽ từ chối. Các cột chung (Action, Title, Description, giá, ảnh...)
  // vẫn điền như file thường.
  const isDraft = opts?.draft === true;
  const set = (row, name, value) => {
    if (isDraft && (name === 'Category' || name.startsWith('C:'))) return;
    const i = col(name);
    if (i >= 0 && value != null && String(value) !== '') row[i] = String(value);
  };
  // File nháp (v8.1): KHÔNG giữ các dòng Info của template mẫu (chúng mang
  // mã 20563 + aspect của gối — sai danh mục của nhóm). Chỉ có dòng Version,
  // dòng header, ĐÚNG 1 dòng cảnh báo DRAFT, rồi các dòng dữ liệu.
  // File upload được của nhóm đã tra mã từ Taxonomy (v8.2): cũng KHÔNG giữ
  // các dòng Info của template gối — thay bằng khối Info đúng của danh mục
  // đã tra (mã + required aspects + recommended values từ Taxonomy).
  // File gối (không có resolvedCategory) vẫn giữ nguyên các dòng Info như cũ.
  const resolvedId = resolved ? String(resolved.categoryId ?? '').trim() : '';
  const useResolvedInfo = !isDraft && resolvedId !== '' && (hasCategoryAspects || resolvedId !== String(template.categoryId));
  const outRows = isDraft
    ? [template.versionRow, headers, draftWarningRow(headers.length)]
    : useResolvedInfo
      ? [template.versionRow, headers, ...resolvedCategoryInfoRows(resolved, headers.length)]
      : [template.versionRow, headers, ...template.infoRows];
  for (const raw of products || []) {
    const p = applyEdits(raw, config);
    const list = listingVariants(p);
    if (!list.length) continue;
    const dims = parseSohoDimensions(p.specs?.Dimensions ?? p.attributes?.dimensions ?? '');
    const weight = parseSohoWeight(p.specs?.Weight ?? p.attributes?.weight ?? '');
    list.forEach((variant, i) => {
      const row = new Array(headers.length).fill('');
      const sku = variant.sku ?? (list.length > 1 ? `${p.id}-${i + 1}` : p.id);
      const sell = listingPriceForExport(p, variant, config, listingCurrency);
      set(row, 'Action', 'Add');
      set(row, 'CustomLabel', sku);
      set(row, 'Category', resolved ? resolved.categoryId : (template.categoryId ?? ''));
      set(row, 'Title', p.title);
      // Leave Relationship/RelationshipDetails empty: every Add row is complete.
      set(row, 'ConditionID', '1000');
      // C:Type: gối khớp theo 22 giá trị của template 20563 (mapEbayType);
      // danh mục khác đã có mã từ Taxonomy thì khớp theo danh sách giá trị
      // cho phép của chính danh mục đó (v9.4, mapResolvedCategoryType).
      // Không khớp được thì để trống + warning ở file nhóm, không bịa.
      set(row, 'C:Type', useResolvedType ? mapResolvedCategoryType(p, variant, resolved) : mapEbayType(p, template));
      set(row, 'C:Brand', aspectFromProduct(p, variant, 'Brand'));
      set(row, 'C:Color', aspectFromProduct(p, variant, 'Color'));
      set(row, 'C:Material', aspectFromProduct(p, variant, 'Material'));
      set(row, 'C:Size', aspectFromProduct(p, variant, 'Size'));
      set(row, 'C:Theme', aspectFromProduct(p, variant, 'Theme'));
      set(row, 'C:Style', aspectFromProduct(p, variant, 'Style'));
      set(row, 'C:Pattern', aspectFromProduct(p, variant, 'Pattern'));
      set(row, 'C:Shape', aspectFromProduct(p, variant, 'Shape'));
      set(row, 'C:Features', aspectFromProduct(p, variant, 'Features'));
      set(row, 'C:Subject', aspectFromProduct(p, variant, 'Subject'));
      set(row, 'C:Room', aspectFromProduct(p, variant, 'Room') ?? roomFromProduct(p, template));
      set(row, 'C:Department', aspectFromProduct(p, variant, 'Department'));
      set(row, 'C:Country of Origin', aspectFromProduct(p, variant, 'Country of Origin'));
      set(row, 'C:Fill Material', aspectFromProduct(p, variant, 'Fill Material'));
      set(row, 'C:Closure Type', aspectFromProduct(p, variant, 'Closure Type'));
      set(row, 'C:Item Height', dims.itemHeight);
      set(row, 'C:Item Width', dims.itemWidth);
      set(row, 'C:Item Length', dims.itemLength);
      set(row, 'C:Item Weight', weight);
      set(row, 'C:Care Instructions', aspectFromProduct(p, variant, 'Care Instructions'));
      // Aspect riêng của danh mục đã có mã từ Taxonomy mà template mẫu
      // không có cột (vd "Bulb Type" của đèn): cột đã thêm vào header ở
      // trên, điền bằng dữ liệu đã có (attributes/specs/AI đã duyệt), chưa
      // có thì để trống — không bịa. 'Type' luôn bỏ qua ở đây vì đã điền
      // ở dòng C:Type trên (gối bằng mapEbayType, danh mục khác bằng
      // mapResolvedCategoryType theo danh sách giá trị Taxonomy) — điền lại
      // bằng aspectFromProduct sẽ ghi đè bằng giá trị chưa kiểm chứng.
      for (const name of extraAspectNames) {
        if (name.toLowerCase() === 'type') continue;
        set(row, `C:${name}`, aspectFromProduct(p, variant, name));
      }
      set(row, 'PicURL', listingImagesForVariant(p, variant).join('|'));
      set(row, 'Description', sanitizeEbayDescription(p.description ?? ''));
      set(row, 'Format', 'FixedPrice');
      set(row, 'Duration', 'GTC');
      set(row, 'StartPrice', sell != null ? sell.toFixed(2) : '');
      set(row, 'Quantity', '1');
      if (explicitCountry) set(row, 'Country', country);
      set(row, 'Location', config.ebayLocation ?? '');
      set(row, 'DispatchTimeMax', config.dispatchTimeMax ?? '');
      set(row, 'ReturnsAcceptedOption', config.returnsAcceptedOption ?? '');
      set(row, 'ReturnsWithinOption', config.returnsWithinOption ?? '');
      set(row, 'RefundOption', config.refundOption ?? '');
      set(row, 'ShippingCostPaidByOption', config.shippingCostPaidByOption ?? '');
      set(row, 'ShippingProfileName', config.shippingProfileName ?? '');
      set(row, 'ReturnProfileName', config.returnProfileName ?? '');
      set(row, 'PaymentProfileName', config.paymentProfileName ?? '');
      outRows.push(row);
    });
  }
  return serializeCsvRows(outRows);
}

// ---- File CSV NHÁP cho nhóm chưa có template (v7, sửa bố cục ở v8.1) ------
// User còn rất nhiều sản phẩm khác và KHÔNG THỂ đưa hết template eBay cho
// từng danh mục được — hướng "đợi template từng nhóm" đã bế tắc. Tool tự
// xoay bằng file nháp: dùng đúng cấu trúc 98 cột của template gối 20563
// đã nhúng sẵn làm mẫu cột (các cột chung của File Exchange là giống nhau),
// điền sẵn các cột chung từ dữ liệu đã có, để trống Category + toàn bộ
// cột C: để team điền nốt khi có template thật. File nháp KHÔNG upload
// được lên Seller Hub — tên file bắt buộc có DRAFT để không upload nhầm.
// Bố cục file nháp (v8.1): dòng Version, dòng header, ĐÚNG 1 dòng cảnh
// báo DRAFT (DRAFT_WARNING_TEXT), rồi các dòng dữ liệu — KHÔNG có các
// dòng Info của template gối (chúng mang mã 20563 + aspect của gối).

/** Xây CSV nháp cho sản phẩm của một nhóm chưa có template. */
export function buildDraftTemplateCsv(products, template, config = {}) {
  return buildEbayTemplateCsv(products, template, config, { draft: true });
}

/**
 * Các cột còn trống trong file nháp, team phải điền trước khi upload:
 * Category + toàn bộ cột C: của template mẫu (vì danh mục thật chưa biết)
 * + các cột shop (Location, Dispatch, Returns, Profile) mà config chưa có.
 * Trả tên cột đã bỏ dấu '*' đầu (vd 'C:Type', 'Category').
 */
export function draftMissingColumns(template, config = {}) {
  const cols = ['Category'];
  for (const h of template?.headers ?? []) {
    const name = String(h).replace(/^\*/, '');
    if (name.startsWith('C:') && !cols.includes(name)) cols.push(name);
  }
  const shop = [
    ['Location', config.ebayLocation],
    ['DispatchTimeMax', config.dispatchTimeMax],
    ['ReturnsAcceptedOption', config.returnsAcceptedOption],
    ['ReturnsWithinOption', config.returnsWithinOption],
    ['RefundOption', config.refundOption],
    ['ShippingCostPaidByOption', config.shippingCostPaidByOption],
    ['ShippingProfileName', config.shippingProfileName],
    ['ReturnProfileName', config.returnProfileName],
    ['PaymentProfileName', config.paymentProfileName],
  ];
  for (const [name, value] of shop) {
    if (value == null || String(value).trim() === '') cols.push(name);
  }
  return cols;
}

/** Nhóm không có danh mục rõ ràng (chưa phân loại / Other) thì không làm
 *  file nháp — file nháp lẫn nhiều loại sẽ không dùng được, team kiểm tay. */
export const DRAFT_SKIP_GROUP_KEYS = ['chua-phan-loai', 'other'];

/**
 * Gợi ý danh mục AI cho file nháp: chấp nhận mảng [{groupKey,
 * suggestedCategory, suggestedAspects}] (trả từ POST /api/ai/draft-
 * categories) hoặc object map {groupKey: {...}}. Trả map key -> gợi ý đã
 * chuẩn hoá (luôn kèm unverified: true — chỉ để hiển thị, KHÔNG ghi vào
 * cột Category của file nháp).
 */
export function draftSuggestionsByGroup(suggestions) {
  const map = new Map();
  const list = Array.isArray(suggestions)
    ? suggestions
    : Object.entries(suggestions ?? {}).map(([groupKey, s]) => ({ groupKey, ...(s ?? {}) }));
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const key = slugifyTheme(s.groupKey) || '';
    const category = String(s.suggestedCategory ?? '').trim();
    if (!key || !category) continue;
    map.set(key, {
      suggestedCategory: category,
      suggestedAspects: Array.isArray(s.suggestedAspects)
        ? [...new Set(s.suggestedAspects.map((a) => String(a ?? '').trim()).filter(Boolean))].slice(0, 10)
        : [],
      unverified: true,
    });
  }
  return map;
}

/**
 * Từ các nhóm (groupProductsByTheme hoặc groupProductsByAiAssignments) xây
 * 1 file CSV NHÁP cho mỗi nhóm CHƯA có template khớp categoryId. Nhóm đã
 * có template (gối 20563) thì bỏ qua — nhóm đó xuất file upload được qua
 * buildGroupedEbayCsvs, không phải nháp. Nhóm chưa phân loại / Other thì
 * ghi vào skipped (không làm file nháp lẫn nhiều loại).
 * Trả { drafts: [{filename, groupKey, label, categoryId: null, isDraft,
 *   csv, productCount, missingColumns, draftCategorySuggestion}],
 *   skipped: [{key, label, productCount, reason}] }.
 * Mỗi file chỉ chứa đúng sản phẩm của nhóm đó, không trộn nhóm.
 */
export function buildDraftGroupedCsvs(products, template, config = {}, groups = null) {
  if (!template || !Array.isArray(template.headers)) {
    throw new Error('Cần template eBay đã parse bằng parseEbayTemplate() — template 20563 đã nhúng sẵn trong tool, không cần nạp tay.');
  }
  const list = groups ?? groupProductsByTheme(products);
  const suggestions = draftSuggestionsByGroup(config.draftCategorySuggestions ?? null);
  const drafts = [];
  const skipped = [];
  for (const g of list) {
    // Lưới an toàn (v8.3): gộp bản ghi trùng id trước khi xuất file nháp
    // (xem buildGroupedEbayCsvs) — mỗi sản phẩm chỉ 1 dòng trong file nháp.
    const gProducts = listingProductsForGroup(g, template, config, skipped);
    if (!gProducts.length) continue;
    if (g.categoryId === template.categoryId) continue; // nhóm có template -> file upload được, không phải nháp
    // Nhóm đã có mã từ Taxonomy (team đã bấm chấp nhận) -> file upload
    // được qua buildGroupedEbayCsvs, không phải nháp.
    if (g.resolvedCategory?.verifiedFromEbay) continue;
    if (DRAFT_SKIP_GROUP_KEYS.includes(g.key)) {
      skipped.push({
        key: g.key,
        label: g.label,
        productCount: gProducts.length,
        reason: `Nhóm "${g.label}" chưa phân loại rõ (sản phẩm chưa gán được nhóm) — kiểm lại tay, không làm file nháp lẫn nhiều loại.`,
      });
      continue;
    }
    drafts.push({
      filename: `ebay-DRAFT-${g.key}.csv`,
      groupKey: g.key,
      label: g.label,
      categoryId: null,
      isDraft: true,
      csv: buildDraftTemplateCsv(gProducts, template, config),
      productCount: gProducts.length,
      missingColumns: draftMissingColumns(template, config),
      draftCategorySuggestion: suggestions.get(g.key) ?? null,
    });
  }
  return { drafts, skipped };
}

// ---- Luồng 1 nút: Sheet -> CSV tự động ------------------------------------
// User chỉ dán 1 link Sheet, bấm 1 nút: tool tự lấy link, tự crawl, tự
// phân loại, tự xuất CSV theo nhóm — không nhập từng link, không tick
// chọn từng link, không nạp template tay (template 20563 nhúng sẵn),
// không xuất tay từng bước. Hàm này là phần lõi dùng chung cho cả web
// và extension: nhận CSV text của sheet + sản phẩm (record crawl thô
// HOẶC product đã chuẩn hoá), trả về file CSV theo nhóm + báo cáo thiếu.

/** Lấy URL ảnh đầu tiên trong HTML DESCRIPTION của sheet (ảnh chính
 *  assets.sohohome.com). Sheet-only product dùng ảnh này làm PicURL;
 *  sanitizeEbayDescription vẫn bỏ thẻ <img> khỏi phần mô tả chữ. */
export function extractImageFromHtml(html) {
  const m = String(html ?? '').match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, '&').trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/** "SohoHome" trong sheet -> "Soho Home" như trên trang sản phẩm. */
export function normalizeSheetBrand(brand) {
  const b = String(brand ?? '').trim();
  if (/^sohohome$/i.test(b)) return 'Soho Home';
  if (/^sohohouse$/i.test(b)) return 'Soho House';
  return b || null;
}

function productSlugFromUrl(url) {
  const m = String(url ?? '').match(/\/products\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/**
 * Chuẩn hoá URL sản phẩm để khớp sheet với bản đã crawl (v8.3): cùng một
 * trang nhưng URL crawl và URL trong sheet có thể khác nhau ở dấu "/" cuối,
 * query string, fragment, http/https hay "www." — khớp chính xác từng ký
 * tự thì trượt, sheet item rơi xuống nhánh fallback thành 1 sản phẩm riêng
 * (trùng id, trùng CustomLabel với bản đã crawl — lỗi file ebay-DRAFT-beds
 * của user 16/11/2026: 2 giường thành 4 dòng).
 * Chuẩn hoá: bỏ fragment, bỏ query trừ khi chứa tham số định danh sản phẩm
 * (id/product/variant/sku), bỏ "/" cuối path, lowercase scheme+host, bỏ
 * "www.". Trả '' khi URL rỗng/không đọc được phần host.
 */
export function normalizeProductUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    const kept = [...u.searchParams.entries()].filter(([k]) => /(^|_)(id|product|variant|sku)($|_)/i.test(k));
    u.search = kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
    const host = u.hostname.replace(/^www\./i, '');
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}${port}${path}${u.search}`;
  } catch {
    return raw.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Gộp dữ liệu sẵn trong sheet vào product đã crawl: sheet có TITLE /
 * DESCRIPTION (HTML sẵn) / COST / SIZE / TYPE / NGÁCH mà trang sản phẩm
 * có thể đọc thiếu. Ưu tiên dữ liệu TRANG (giá non-member, ảnh, specs);
 * chỉ dùng sheet để lấp chỗ trống — không ghi đè dữ liệu trang.
 */
export function enrichProductFromSheet(product, sheetItem) {
  if (!product || !sheetItem) return product;
  const p = { ...product, variants: (product.variants ?? []).map((v) => ({ ...v, options: { ...(v.options ?? {}) } })) };
  if (!p.theme && (sheetItem.theme || sheetItem.type)) p.theme = sheetItem.theme ?? sheetItem.type;
  if (!p.brand && sheetItem.brand) p.brand = normalizeSheetBrand(sheetItem.brand);
  if (!p.description && sheetItem.description) p.description = sheetItem.description;
  // Ảnh: nếu trang chưa crawl được ảnh, lấy ảnh chính trong DESCRIPTION
  // HTML của sheet (assets.sohohome.com) làm PicURL.
  if (!(p.images ?? []).length && sheetItem.description) {
    const img = extractImageFromHtml(sheetItem.description);
    if (img) p.images = [img];
  }
  if ((p.price == null || p.price <= 0) && sheetItem.cost != null) {
    p.price = sheetItem.cost;
    p.price_estimated = true;
    p.variants.forEach((v) => { if (v.price == null) v.price = sheetItem.cost; });
  }
  // GIÁ BÁN trong sheet là giá bán eBay đã chốt: dùng làm StartPrice
  // (edits.price) khi có; chỉ tính lại bằng calcSellPrice khi sheet
  // không có GIÁ BÁN. Không ghi đè GIÁ BÁN bằng công thức mặc định.
  const giaBan = sheetItem.gia_ban ?? sheetItem.sell_price ?? null;
  if (giaBan != null && (p.edits?.price == null)) p.edits = { ...(p.edits ?? {}), price: giaBan };
  // SIZE trong sheet lấp cho sản phẩm đơn biến thể chưa có Size.
  if (sheetItem.size && p.variants.length === 1 && !p.variants[0].options?.Size) {
    p.variants[0].options.Size = String(sheetItem.size);
    if (!p.option_names?.includes('Size')) p.option_names = [...(p.option_names ?? []), 'Size'];
  }
  return p;
}

/** Một record thô từ sheet (chưa crawl trang): tạo product tối thiểu để
 *  luồng 1 nút vẫn xuất được CSV, kèm cờ để báo cáo ghi rõ "chưa crawl
 *  trang — ảnh/thông số lấy từ sheet, cần kiểm lại trước khi upload". */
export function productFromSheetItem(item) {
  const url = item?.url ?? '';
  const slug = productSlugFromUrl(url) ?? url;
  const title = (item?.title ?? item?.title_hint ?? '').trim();
  // Dòng sheet trống TITLE (vd 4 dòng trong file thật: Mayfair Toilet
  // Brush Holder, Daxton Square Cushion trùng, Vende Cushion, Antonia
  // Cushion — COST trống, GIÁ BÁN chỉ $0,49): KHÔNG tự bịa tên từ slug,
  // trả null để autoSheetToCsv báo rõ dòng thiếu dữ liệu và loại khỏi CSV.
  if (!title) return null;
  const { product } = normalizeRecord({
    source_site: (() => { try { return new URL(url).hostname; } catch { return 'sohohome.com'; } })(),
    source_product_id: slug,
    source_url: url,
    title,
    brand: normalizeSheetBrand(item?.brand) ?? 'Soho Home',
    price: item?.cost ?? null,
    currency: 'USD',
    description_text: item?.description ?? null,
    theme: item?.theme ?? item?.type ?? null,
    variants: [{ options: item?.size ? { Size: String(item.size) } : {}, price: item?.cost ?? null, in_stock: true }],
    images: [],
  });
  if (!product) return null;
  product.sheet_only = true;
  product.price_estimated = true;
  // Ảnh chính lấy từ DESCRIPTION HTML của sheet (nếu có).
  const sheetImg = extractImageFromHtml(item?.description);
  if (sheetImg) product.images = [sheetImg];
  const giaBan = item?.gia_ban ?? item?.sell_price ?? null;
  if (giaBan != null) product.edits = { ...(product.edits ?? {}), price: giaBan };
  return product;
}

function missingFieldsFor(product, template, config = {}) {
  const missing = [];
  // Nhóm đã có mã từ Taxonomy khác 20563 (vd đèn): kiểm tra Type/Brand
  // theo danh sách cho phép của template GỐI là sai — danh mục đó có
  // danh sách riêng của nó (lấy qua Taxonomy). Chỉ báo thiếu trường khi
  // chưa có mã xác minh; trường bắt buộc theo Taxonomy đã liệt kê trong
  // báo cáo missingAspects của file nhóm đó.
  const hasVerifiedOtherCategory = (product.edits?.ebayCategoryId ?? '').toString().trim()
    && String(product.edits.ebayCategoryId) !== String(template?.categoryId);
  if (!hasVerifiedOtherCategory) {
    if (!mapEbayType(product, template)) missing.push('thiếu Type (không khớp giá trị cho phép của template — cần điền tay)');
    const brandList = template?.recommendedValues?.Brand ?? [];
    if (product.brand && brandList.length && !brandList.includes(product.brand)) {
      missing.push(`Brand "${product.brand}" không có trong danh sách ~${Math.round(brandList.length / 100) * 100} brand của template — cần upload thử để xác nhận eBay có nhận không`);
    }
  }
  if (!product.brand) missing.push('thiếu Brand');
  if (!(product.images ?? []).length) missing.push('thiếu ảnh (chưa crawl được ảnh từ trang — kiểm lại link)');
  if (product.price == null || product.price <= 0) missing.push('thiếu giá nguồn');
  else if (product.price < 1) missing.push(`giá nguồn chỉ $${product.price} — nghi thiếu dữ liệu giá, cần kiểm lại`);
  const sellPrice = product.edits?.price;
  if (sellPrice != null && sellPrice > 0 && sellPrice < 1) missing.push(`GIÁ BÁN trong sheet chỉ $${sellPrice} — nghi thiếu dữ liệu, cần kiểm lại trước khi upload`);
  if (!product.description) missing.push('thiếu mô tả');
  if (product.sheet_only) missing.push('chưa crawl trang sản phẩm — dữ liệu chỉ từ sheet, cần kiểm lại ảnh/thông số trước khi upload');
  return missing;
}

/**
 * Luồng 1 nút: Sheet CSV text + sản phẩm -> file CSV eBay theo nhóm.
 * @param {string} sheetCsvText - CSV text của tab sheet (đã fetch qua link export).
 * @param {Array} productRecords - record crawl thô HOẶC product đã chuẩn hoá
 *   (có id + version thì dùng nguyên, giữ edits; không có thì normalizeRecord).
 * @param {object} template - template eBay đã parse bằng parseEbayTemplate().
 * @param {object} [config] - cấu hình giá + Location/Dispatch/Returns/Profile.
 *   config.aiAssignments (tùy chọn): kết quả POST /api/ai/group
 *   ([{productId, groupKey, groupLabel, ebayType}]) — có thì nhóm theo AI,
 *   đồng thời ghi aiGroup/aiGroupLabel (+ ebayType hợp lệ khi chưa có) vào
 *   edits của sản phẩm trả về; không có thì nhóm theo từ khoá như cũ.
 *   config.taxonomyResolutions (tùy chọn, v8): kết quả POST
 *   /api/ebay/resolve-groups đã được team chấp nhận
 *   ([{groupKey, categoryId, categoryName, categoryPath, requiredAspects,
 *   recommendedAspects}]) — nhóm đó xuất file upload được thay vì file
 *   nháp, đồng thời ghi edits.ebayCategoryId vào sản phẩm trả về.
 * @returns {{ sheetItems, products, groups, files, skipped, missing, warnings, stats }}
 *   files: [{ filename, groupKey, label, categoryId, csv, productCount }]
 *   skipped: [{ key, label, reason, productCount }] — nhóm chưa có template
 *     (vd thảm/bàn với template gối 20563) thì KHÔNG xuất, ghi rõ lý do.
 *   skippedSheetRows: [{ url, source_row, reason }] — dòng sheet trống
 *     TITLE/COST thì không tự bịa tên/giá, không đưa vào CSV.
 *   missing: [{ productId, title, missing: [] }] — từng sản phẩm thiếu trường nào.
 *   warnings: cảnh báo chung (vd Location/Profile còn trống).
 */
export function autoSheetToCsv(sheetCsvText, productRecords, template, config = {}) {
  if (!template || !Array.isArray(template.headers)) {
    throw new Error('Cần template eBay đã parse bằng parseEbayTemplate() — template 20563 đã nhúng sẵn trong tool, không cần nạp tay.');
  }
  const { items: sheetItems } = parseSheetCsv(sheetCsvText ?? '');
  // Khớp sheet với sản phẩm đã crawl bằng URL ĐÃ CHUẨN HOÁ (v8.3): URL
  // crawl khác URL sheet ở dấu "/" cuối, query, http/https hay "www."
  // thì khớp chính xác sẽ trượt, sheet item rơi xuống nhánh fallback
  // thành 1 sản phẩm riêng trùng id (lỗi 2 giường thành 4 dòng của user).
  const byUrl = new Map(sheetItems.map((it) => [normalizeProductUrl(it.url), it]));
  const normalized = [];
  for (const input of productRecords ?? []) {
    if (!input) continue;
    if (input.id && input.version != null && Array.isArray(input.variants)) {
      normalized.push({ ...input });
    } else {
      const { product } = normalizeRecord(input);
      if (product) normalized.push(product);
    }
  }
  // Gộp sheet vào sản phẩm đã crawl (khớp theo URL đã chuẩn hoá); sheet
  // item nào chưa có sản phẩm tương ứng thì tạo product tối thiểu từ dữ
  // liệu sheet. Dòng sheet trống TITLE (vd 4 dòng trong file thật) thì
  // productFromSheetItem trả null — ghi vào skippedSheetRows, không tự bịa
  // tên/giá, không xuất.
  const seenUrls = new Set();
  let products = normalized.map((p) => {
    const sheet = p.source_url ? byUrl.get(normalizeProductUrl(p.source_url)) : null;
    if (sheet) seenUrls.add(normalizeProductUrl(sheet.url));
    return sheet ? enrichProductFromSheet(p, sheet) : p;
  });
  const skippedSheetRows = [];
  for (const item of sheetItems) {
    if (seenUrls.has(normalizeProductUrl(item.url))) continue;
    const fallback = productFromSheetItem(item);
    if (fallback) { products.push(fallback); continue; }
    skippedSheetRows.push({
      url: item.url,
      source_row: item.source_row ?? null,
      title: item.title ?? null,
      reason: 'Dòng sheet trống TITLE và COST (GIÁ BÁN chỉ $0,49) — thiếu dữ liệu, không tự bịa tên/giá, không đưa vào CSV xuất.',
    });
  }
  // Lưới an toàn cuối cùng (v8.3): gộp các sản phẩm TRÙNG (cùng id + cùng
  // URL sản phẩm, xem dedupeProductsById) trước khi nhóm/xuất — dữ liệu
  // local của user có thể đã có 2 bản ghi cùng id do chạy 2 lần trước khi
  // sửa lỗi khớp URL; gộp lúc xuất xử lý được mà không cần họ xoá dữ liệu
  // tay (không sửa dữ liệu store của họ). Chỉ so id là không đủ: 2 màu
  // khác nhau của cùng slug (vd Vinnie Bisque/Sage) vẫn trùng id nhưng
  // là 2 sản phẩm khác nhau, không được gộp.
  const deduped = dedupeProductsById(products);
  products = deduped.products;
  const mergedDuplicateProducts = deduped.mergedDuplicateProducts;
  // Nhóm bằng AI khi có assignments (POST /api/ai/group): ghi aiGroup /
  // aiGroupLabel (+ ebayType hợp lệ khi chưa có) vào edits của sản phẩm
  // trả về, để lần sau mở lại vẫn còn nhóm; không có thì nhóm theo từ khoá.
  const aiAssignments = Array.isArray(config.aiAssignments) ? config.aiAssignments : null;
  let groups;
  if (aiAssignments) {
    const byId = new Map(aiAssignments.map((a) => [a.productId, a]));
    const allowedTypes = template.recommendedValues?.Type ?? EBAY_TYPES_20563;
    for (const p of products) {
      const a = byId.get(p.id);
      if (!a) continue;
      p.edits = { ...(p.edits ?? {}) };
      if (a.groupKey) p.edits.aiGroup = a.groupKey;
      if (a.groupLabel) p.edits.aiGroupLabel = a.groupLabel;
      if (a.ebayType && allowedTypes.includes(a.ebayType) && !p.edits.ebayType) {
        p.edits.ebayType = a.ebayType;
      }
    }
    groups = groupProductsByAiAssignments(products, aiAssignments);
  } else {
    groups = groupProductsByTheme(products);
  }
  // Mã danh mục đã xác minh từ eBay (POST /api/ebay/resolve-groups, team
  // đã bấm chấp nhận — config.taxonomyResolutions): ghi vào nhóm + edits
  // của sản phẩm để nhóm đó xuất file upload được thay vì file nháp.
  // Mã do AI đoán (draftCategorySuggestion) KHÔNG đi qua đây.
  const taxonomyApplied = applyTaxonomyResolutions(products, groups, config.taxonomyResolutions);
  const { files, skipped } = buildGroupedEbayCsvs(products, template, config, groups);
  // File nháp (v7) cho các nhóm chưa có template: dùng cấu trúc 98 cột của
  // template gối làm mẫu, điền sẵn cột chung, để trống Category + toàn bộ
  // cột C:. Gợi ý danh mục AI (nếu có) truyền qua config.draftCategory-
  // Suggestions — chỉ gắn vào file nháp để hiển thị, KHÔNG ghi vào CSV.
  const { drafts: draftFiles, skipped: draftSkipped } = buildDraftGroupedCsvs(products, template, config, groups);
  const missing = products.map((p) => {
    const list = missingFieldsFor(p, template, config);
    return list.length ? { productId: p.id, title: p.title, missing: list } : null;
  }).filter(Boolean);
  const warnings = [];
  if (!config.ebayLocation) warnings.push('Location còn trống — điền trước khi upload lên Seller Hub.');
  if (!config.dispatchTimeMax) warnings.push('DispatchTimeMax còn trống — điền số ngày xử lý trước khi upload.');
  if (!config.returnsAcceptedOption) warnings.push('ReturnsAcceptedOption còn trống — điền chính sách đổi trả trước khi upload.');
  if (!config.shippingProfileName && !config.returnProfileName && !config.paymentProfileName) {
    warnings.push('Chưa có Shipping/Return/Payment Profile — điền tên profile đã tạo trong tài khoản eBay, hoặc điền chi tiết ship/return tay.');
  }
  return {
    sheetItems,
    products,
    groups,
    files,
    skipped,
    draftFiles,
    draftSkipped,
    skippedSheetRows,
    missing,
    warnings,
    stats: {
      sheetLinks: sheetItems.length,
      products: products.length,
      mergedDuplicateProducts,
      exportedGroups: files.length,
      exportedProducts: files.reduce((n, f) => n + f.productCount, 0),
      skippedGroups: skipped.length,
      draftFiles: draftFiles.length,
      draftProducts: draftFiles.reduce((n, f) => n + f.productCount, 0),
      draftSkippedGroups: draftSkipped.length,
      taxonomyResolvedGroups: taxonomyApplied.appliedGroups,
      taxonomyResolvedProducts: taxonomyApplied.appliedProducts,
      skippedSheetRows: skippedSheetRows.length,
      productsWithMissingFields: missing.length,
    },
  };
}

// Trình duyệt: expose global để app.js (không phải module) dùng được.
if (typeof window !== 'undefined') {
  window.CsvEbayCore = {
    MAX_VARIANTS, MAX_TITLE_LENGTH, EBAY_TYPES_20563, AI_SPECIFIC_ASPECTS, SITE_RANGES, WOMEN_ONLY_SITES, CATEGORY_KEYWORDS,
    normalizeSite, hashProductId, truncateTitle, suggestCategory, validatePrice, calcSellPrice, listingPriceForVariant,
    normalizeVariant, optionNamesFor, variantRelationshipDetails, normalizeRecord, parseImport,
    mergeProducts, dedupeProductsById, normalizeProductUrl, applyEdits, csvEscape, looksLikeCsvFormula, CSV_HEADERS, CSV_UTF8_BOM, buildCsv,
    parseCsvText, serializeCsvRows, parseEbayTemplate, THEME_KEYWORDS, slugifyTheme,
    groupProductsByTheme, parseSohoDimensions, parseSohoWeight,
    parseBulkList, parseSheetCsv, parseMoneyCell, sanitizeEbayDescription, templateColumnIndex,
    mapEbayType, matchTypeValue, resolvedTypeValues, mapResolvedCategoryType, buildEbayTemplateCsv, THEME_VI_KEYWORDS, resolveThemeGroup,
    normalizeSheetBrand, enrichProductFromSheet, productFromSheetItem, autoSheetToCsv,
    extractImageFromHtml, groupProductsByAiAssignments, buildGroupedEbayCsvs, validateEbayTemplateProducts,
    buildDraftTemplateCsv, draftMissingColumns, buildDraftGroupedCsvs,
    draftSuggestionsByGroup, DRAFT_SKIP_GROUP_KEYS, DRAFT_WARNING_TEXT,
    resolvedCategoryFromEdits, getAspectValue, applyTaxonomyResolutions,
    parseEbaySoldCount, parseEbayItemId, parseEbayWatchers,
    sourceProductIdFromUrl, RESEARCH_CSV_HEADERS, researchRowForProduct,
    buildResearchCsv, buildResearchGroupedCsvs,
  };
}
export default {
  MAX_VARIANTS, MAX_TITLE_LENGTH, EBAY_TYPES_20563, AI_SPECIFIC_ASPECTS, SITE_RANGES, WOMEN_ONLY_SITES, CATEGORY_KEYWORDS,
  normalizeSite, hashProductId, truncateTitle, suggestCategory, validatePrice, calcSellPrice, listingPriceForVariant,
  normalizeVariant, optionNamesFor, variantRelationshipDetails, normalizeRecord, parseImport,
  mergeProducts, dedupeProductsById, normalizeProductUrl, applyEdits, csvEscape, looksLikeCsvFormula, CSV_HEADERS, CSV_UTF8_BOM, buildCsv,
  parseCsvText, serializeCsvRows, parseEbayTemplate, THEME_KEYWORDS, slugifyTheme,
  groupProductsByTheme, parseSohoDimensions, parseSohoWeight,
  parseBulkList, parseSheetCsv, parseMoneyCell, sanitizeEbayDescription, templateColumnIndex,
  mapEbayType, matchTypeValue, resolvedTypeValues, mapResolvedCategoryType, buildEbayTemplateCsv, THEME_VI_KEYWORDS, resolveThemeGroup,
  normalizeSheetBrand, enrichProductFromSheet, productFromSheetItem, autoSheetToCsv,
  extractImageFromHtml, groupProductsByAiAssignments, buildGroupedEbayCsvs, validateEbayTemplateProducts,
  buildDraftTemplateCsv, draftMissingColumns, buildDraftGroupedCsvs,
  draftSuggestionsByGroup, DRAFT_SKIP_GROUP_KEYS, DRAFT_WARNING_TEXT,
  resolvedCategoryFromEdits, getAspectValue, applyTaxonomyResolutions,
  parseEbaySoldCount, parseEbayItemId, parseEbayWatchers,
  sourceProductIdFromUrl, RESEARCH_CSV_HEADERS, researchRowForProduct,
  buildResearchCsv, buildResearchGroupedCsvs,
};
