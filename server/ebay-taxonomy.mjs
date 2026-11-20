// server/ebay-taxonomy.mjs — Tra mã danh mục eBay bằng Taxonomy API.
// KHÔNG đoán mã danh mục bằng AI: mã dùng để xuất file CSV upload được
// CHỈ lấy từ Taxonomy API của eBay (đã xác minh — verifiedFromEbay) hoặc
// từ template thật user nạp vào. Mã do AI đoán (draftCategorySuggestion
// ở v7) là phỏng đoán chưa xác minh, KHÔNG BAO GIỜ ghi vào cột Category.
//
// Xác thực: OAuth 2.0 application token (client credentials grant) bằng
// App ID (Client ID) + Cert ID (Client Secret) của tài khoản eBay
// Developers. Token chỉ nằm trong RAM server, cache kèm thời gian hết hạn
// (~2 giờ), tự làm mới trước khi hết hạn; token lỗi/hết hạn thì làm mới
// 1 lần rồi thử lại, vẫn lỗi thì trả lỗi rõ, không crash route.
// Khóa KHÔNG BAO GIỜ rời server: không có trong extension, không lưu
// localStorage, không trả ra ngoài qua API, không ghi log. Khóa lấy theo
// thứ tự: biến môi trường EBAY_APP_ID + EBAY_CERT_ID (.env dev / wrangler
// secret khi deploy) trước, rồi khóa dán trong web (POST /api/ebay/config,
// chỉ lưu trong RAM, mất khi restart). Không có khóa thì các nhóm giữ
// nguyên file nháp như v7.
//
// Chạy được cả Node (dev-server) và Cloudflare Workers: fetch được truyền
// vào qua runtime.fetchFn (mặc định globalThis.fetch), env được đưa vào
// qua applyEnvToRuntime() — không đọc process.env trực tiếp trong module
// này để Workers vẫn dùng được.
//
// Tài liệu chính thức (đã đối chiếu 16/11/2026):
// - Taxonomy API Quick Start Guide (partnerhelp.ebay.com): base
//   https://api.ebay.com/commerce/taxonomy/v1, GET /get_default_category_
//   tree_id?marketplace_id=EBAY_US (trả tree id 0 cho thị trường Mỹ),
//   GET /category_tree/0/get_category_suggestions?q=<từ khoá> (trả các
//   leaf category gợi ý kèm id + đường dẫn),
//   GET /category_tree/0/get_category_subtree?category_id=<id> (kiểm tra
//   leafCategoryTreeNode), GET /category_tree/0/get_item_aspects_for_category?
//   category_id=<id> (trường bắt buộc/khuyến nghị của danh mục đó — chỉ dùng
//   cho leaf category; đừng nhầm với fetch_item_aspects, method lấy trường
//   của TẤT CẢ leaf category trong 1 lần gọi).
// - OAuth: POST https://api.ebay.com/identity/v1/oauth2/token, Basic auth
//   = App ID + Cert ID, grant_type=client_credentials, scope
//   https://api.ebay.com/oauth/api_scope. Sandbox dùng
//   api.sandbox.ebay.com và khóa riêng; mặc định dùng production.

export const EBAY_TAXONOMY_BASE_URLS = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
};
export const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';
export const EBAY_MARKETPLACE_US = 'EBAY_US';
export const EBAY_ENVIRONMENTS = ['production', 'sandbox'];
/** Token application thường có hạn ~2 giờ (7200s); trừ 60s đệm khi cache. */
export const EBAY_TOKEN_EXPIRY_BUFFER_MS = 60_000;
export const EBAY_TIMEOUT_MS = 20_000;
/** Số gợi ý danh mục tối đa trả về cho 1 từ khoá tra tay. */
export const EBAY_SUGGESTIONS_LIMIT = 10;
/** Số nhóm tối đa tra mã trong 1 lần gọi resolve-groups. */
export const EBAY_RESOLVE_MAX_GROUPS = 50;
/** Cache gợi ý/aspects trong RAM để không gọi lặp cùng từ khoá/mã. */
export const EBAY_CACHE_MAX_ENTRIES = 200;

/** Lỗi gọi eBay: mang code để endpoint trả mã lỗi rõ (không lộ key/token). */
export class EbayTaxonomyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EbayTaxonomyError';
    this.code = code;
  }
}

/** Lỗi có phải do chạm giới hạn request (429) không. */
export function isEbayRateLimitError(error) {
  return /429|rate.?limit|RATE_LIMIT/i.test(String(error?.message ?? error?.code ?? ''));
}

/** Base64 Basic auth (App ID + Cert ID) — chạy được cả Node và Workers
 *  (btoa có sẵn ở cả hai; fallback mã hoá tay khi không có btoa). */
export function basicAuthHeader(appId, certId) {
  const raw = `${appId}:${certId}`;
  let encoded;
  if (typeof globalThis.btoa === 'function') {
    // App ID / Cert ID là chuỗi ASCII nên btoa dùng được thẳng.
    encoded = globalThis.btoa(raw);
  } else {
    const bytes = new TextEncoder().encode(raw);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[n & 63] : '=');
    }
    encoded = out;
  }
  return `Basic ${encoded}`;
}

/** Fetch có timeout: đua fetch với promise timeout — chỉ abort() signal
 *  thì chưa đủ, vì một fetch treo (promise không bao giờ settle) sẽ không
 *  bị reject khi signal abort. Timeout 20s mặc định (EBAY_TIMEOUT_MS).
 *  Export để server/ebay-browse.mjs dùng chung (cùng pattern gọi eBay). */
export async function fetchWithTimeout(url, init, fetchFn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EbayTaxonomyError('ebay_timeout', `eBay timeout sau ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (e) {
    if (e instanceof EbayTaxonomyError) throw e;
    if (e?.name === 'AbortError' || controller.signal.aborted) {
      throw new EbayTaxonomyError('ebay_timeout', `eBay timeout sau ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cachePut(map, key, value) {
  if (map.size >= EBAY_CACHE_MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

function categoryIdText(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(id)) throw new EbayTaxonomyError('invalid_category_id', 'Category ID phải là mã số danh mục eBay.');
  return id;
}

function suggestionPath(suggestion, categoryName) {
  // The official response lists ancestors from immediate parent to root.
  // Root metadata is not meaningful and must not appear in a seller's path.
  const ancestors = Array.isArray(suggestion.categoryTreeNodeAncestors)
    ? suggestion.categoryTreeNodeAncestors.filter((a) => a && a.categoryTreeNodeLevel !== 0).slice().reverse()
    : [];
  const names = ancestors.map((a) => String(a.categoryName ?? '').trim()).filter(Boolean);
  if (names.length) return [...names, categoryName].join(' > ');
  return String(suggestion.categoryTreeNodePath ?? suggestion.path ?? suggestion.category?.categoryTreeNodePath ?? '').trim() || categoryName;
}

/** Lấy env eBay từ một object env (process.env ở dev, env Workers khi deploy).
 *  Key CHỈ kiểm tra không rỗng — không kiểm tra định dạng/tiền tố. */
export function pickEbayEnv(env) {
  const e = env ?? {};
  const environment = typeof e.EBAY_ENVIRONMENT === 'string' && e.EBAY_ENVIRONMENT.trim()
    ? e.EBAY_ENVIRONMENT.trim().toLowerCase()
    : null;
  return {
    appId: typeof e.EBAY_APP_ID === 'string' && e.EBAY_APP_ID.trim() ? e.EBAY_APP_ID.trim() : null,
    certId: typeof e.EBAY_CERT_ID === 'string' && e.EBAY_CERT_ID.trim() ? e.EBAY_CERT_ID.trim() : null,
    environment: environment && EBAY_ENVIRONMENTS.includes(environment) ? environment : null,
    marketplaceId: typeof e.EBAY_MARKETPLACE_ID === 'string' && e.EBAY_MARKETPLACE_ID.trim()
      ? e.EBAY_MARKETPLACE_ID.trim().toUpperCase().replace(/-/g, '_')
      : null,
  };
}

export class EbayTaxonomyRuntime {
  constructor(env = {}) {
    this.env = pickEbayEnv(env);
    // Khóa dán trong web: chỉ trong RAM, mất khi restart, không ghi file/log.
    this.memory = { appId: null, certId: null, environment: null, marketplaceId: null };
    this.fetchFn = globalThis.fetch;
    // Token application cache trong RAM: { token, expiresAt }.
    this.tokenCache = null;
    // Tree id cache theo marketplace: marketplaceId -> treeId.
    this.treeIdCache = new Map();
    // Cache gợi ý theo từ khoá + aspects theo categoryId (RAM, tối đa 200).
    this.suggestionCache = new Map();
    this.aspectsCache = new Map();
    this.categoryNodeCache = new Map();
  }

  /** Đưa env mới vào runtime (dev-server lúc khởi động / Workers mỗi request). */
  applyEnv(env) {
    const next = pickEbayEnv(env);
    this.env = {
      appId: next.appId ?? this.env.appId,
      certId: next.certId ?? this.env.certId,
      environment: next.environment ?? this.env.environment,
      marketplaceId: next.marketplaceId ?? this.env.marketplaceId,
    };
    return this.getStatus();
  }

  /** Cấu hình hiệu lực: khóa lấy env trước rồi mới tới khóa dán trong web;
   *  environment/marketplace lấy khóa dán trong web trước rồi mới tới env. */
  getEffectiveConfig() {
    const environment = this.memory.environment ?? this.env.environment ?? 'production';
    const safeEnvironment = EBAY_ENVIRONMENTS.includes(environment) ? environment : 'production';
    return {
      environment: safeEnvironment,
      marketplaceId: this.memory.marketplaceId ?? this.env.marketplaceId ?? EBAY_MARKETPLACE_US,
      appId: this.env.appId ?? this.memory.appId ?? null,
      certId: this.env.certId ?? this.memory.certId ?? null,
      source: (this.env.appId && this.env.certId) ? 'env' : ((this.memory.appId && this.memory.certId) ? 'web' : 'none'),
    };
  }

  /** Trạng thái an toàn để trả ra ngoài: KHÔNG BAO GIỜ chứa key/token. */
  getStatus() {
    const cfg = this.getEffectiveConfig();
    return {
      configured: Boolean(cfg.appId && cfg.certId),
      marketplace: cfg.marketplaceId,
      environment: cfg.environment,
      source: cfg.source,
    };
  }

  /**
   * Lưu cấu hình dán trong web vào RAM. appId/certId: chuỗi không rỗng ->
   * lưu; '' -> xoá trong RAM; undefined -> giữ nguyên. Đổi khóa/môi trường
   * thì xoá token cache để lần gọi sau lấy token mới. Không trả key ra.
   */
  setMemoryConfig({ appId, certId, environment, marketplaceId } = {}) {
    if (environment !== undefined && environment !== null && String(environment).trim() !== '') {
      const env = String(environment).trim().toLowerCase();
      if (!EBAY_ENVIRONMENTS.includes(env)) throw { code: 'invalid_environment', environment: env };
      if (env !== this.memory.environment) this.tokenCache = null;
      this.memory.environment = env;
    }
    if (marketplaceId !== undefined && marketplaceId !== null && String(marketplaceId).trim() !== '') {
      this.memory.marketplaceId = String(marketplaceId).trim().toUpperCase().replace(/-/g, '_');
    }
    if (appId !== undefined) {
      const next = (typeof appId === 'string' && appId.trim()) ? appId.trim() : null;
      if (next !== this.memory.appId) this.tokenCache = null;
      this.memory.appId = next;
    }
    if (certId !== undefined) {
      const next = (typeof certId === 'string' && certId.trim()) ? certId.trim() : null;
      if (next !== this.memory.certId) this.tokenCache = null;
      this.memory.certId = next;
    }
    return this.getStatus();
  }

  clearMemoryConfig() {
    this.memory = { appId: null, certId: null, environment: null, marketplaceId: null };
    this.tokenCache = null;
    return this.getStatus();
  }

  /** Base URL theo môi trường (production mặc định, sandbox dùng khóa riêng). */
  baseUrl() {
    return EBAY_TAXONOMY_BASE_URLS[this.getEffectiveConfig().environment];
  }

  /**
   * Lấy application token (client credentials grant), cache trong RAM kèm
   * thời gian hết hạn (trừ 60s đệm). forceRefresh=true thì bỏ cache, lấy
   * mới — dùng khi API trả 401 (token hết hạn giữa chừng).
   */
  async getApplicationToken({ forceRefresh = false } = {}) {
    const cfg = this.getEffectiveConfig();
    if (!cfg.appId || !cfg.certId) {
      throw new EbayTaxonomyError('ebay_not_configured', 'Chưa có khóa eBay (App ID + Cert ID) — đăng ký tài khoản eBay Developers rồi dán khóa vào tab eBay Taxonomy, hoặc đặt EBAY_APP_ID / EBAY_CERT_ID trong .env.');
    }
    if (!forceRefresh && this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }
    const url = `${this.baseUrl()}/identity/v1/oauth2/token`;
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basicAuthHeader(cfg.appId, cfg.certId),
        },
        body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_OAUTH_SCOPE)}`,
      }, this.fetchFn, EBAY_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof EbayTaxonomyError) throw e;
      throw new EbayTaxonomyError('ebay_connection_failed', `Không kết nối được eBay để lấy token (${e?.message ?? 'lỗi mạng'}) — kiểm tra mạng rồi thử lại.`);
    }
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        throw new EbayTaxonomyError('ebay_auth_failed', `eBay từ chối khóa (HTTP ${res.status}) — kiểm tra lại App ID + Cert ID${cfg.environment === 'sandbox' ? ' của SANDBOX' : ' production'}: khóa production và sandbox khác nhau, không dùng lẫn được.`);
      }
      if (res.status === 429) {
        throw new EbayTaxonomyError('ebay_rate_limit', 'eBay chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại.');
      }
      throw new EbayTaxonomyError('ebay_auth_failed', `eBay lỗi khi lấy token (HTTP ${res.status}).`);
    }
    const data = await res.json().catch(() => ({}));
    const token = data?.access_token;
    if (!token) {
      throw new EbayTaxonomyError('ebay_auth_failed', 'eBay không trả access_token — kiểm tra lại App ID + Cert ID.');
    }
    const ttlMs = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 2 * 60 * 60 * 1000;
    this.tokenCache = { token, expiresAt: Date.now() + ttlMs - EBAY_TOKEN_EXPIRY_BUFFER_MS };
    return token;
  }

  /**
   * GET một endpoint Taxonomy đã xác thực. Token hết hạn (401) thì làm
   * mới 1 lần rồi thử lại; vẫn lỗi thì trả lỗi rõ. Không log token/key.
   */
  async taxonomyGet(path, { forceRefreshToken = false } = {}) {
    const token = await this.getApplicationToken({ forceRefresh: forceRefreshToken });
    let res;
    try {
      res = await fetchWithTimeout(`${this.baseUrl()}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, this.fetchFn, EBAY_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof EbayTaxonomyError) throw e;
      throw new EbayTaxonomyError('ebay_connection_failed', `Không kết nối được eBay (${e?.message ?? 'lỗi mạng'}) — kiểm tra mạng rồi thử lại.`);
    }
    if (res.status === 401 && !forceRefreshToken) {
      return this.taxonomyGet(path, { forceRefreshToken: true });
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new EbayTaxonomyError('ebay_rate_limit', 'eBay chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại.');
      }
      if (res.status === 404) {
        throw new EbayTaxonomyError('ebay_not_found', `eBay không tìm thấy dữ liệu (HTTP 404) cho ${path} — mã danh mục có thể đã hết hạn hoặc đổi, thử tra lại.`);
      }
      throw new EbayTaxonomyError('ebay_api_error', `eBay lỗi (HTTP ${res.status}) khi gọi ${path}.`);
    }
    return res.json().catch(() => ({}));
  }

  /** Tree id của thị trường (EBAY_US -> "0"), cache theo marketplace. */
  async getDefaultCategoryTreeId() {
    const cfg = this.getEffectiveConfig();
    const cacheKey = `${cfg.environment}|${cfg.marketplaceId}`;
    const cached = this.treeIdCache.get(cacheKey);
    if (cached) return cached;
    const data = await this.taxonomyGet(`/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(cfg.marketplaceId)}`);
    const treeId = data?.categoryTreeId != null ? String(data.categoryTreeId) : null;
    if (!treeId) throw new EbayTaxonomyError('ebay_api_error', 'eBay không trả categoryTreeId cho thị trường này.');
    this.treeIdCache.set(cacheKey, treeId);
    return treeId;
  }

  /**
   * Gợi ý danh mục theo từ khoá (getCategorySuggestions). CHỈ nhận
   * category là LEAF: gợi ý nào có cờ leafCategoryTreeNode=false thì bỏ;
   * gợi ý không kèm cờ leaf (eBay nói suggestions đã là leaf) thì giữ.
   * Trả [{id, name, path, leaf}] (leaf: true khi đã xác nhận là leaf,
   * null khi eBay không kèm cờ — bên resolve-groups sẽ kiểm tra lại bằng
   * getCategorySubtree trước khi đánh dấu verifiedFromEbay).
   */
  async getCategorySuggestions(query, { limit = EBAY_SUGGESTIONS_LIMIT } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new EbayTaxonomyError('query_required', 'Cần từ khoá để tra danh mục eBay.');
    const cfg = this.getEffectiveConfig();
    const cacheKey = `${cfg.environment}|${cfg.marketplaceId}|${q.toLowerCase()}`;
    const cached = this.suggestionCache.get(cacheKey);
    if (cached) return cached.slice(0, limit);
    const treeId = await this.getDefaultCategoryTreeId();
    const data = await this.taxonomyGet(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions?q=${encodeURIComponent(q)}`);
    const raw = Array.isArray(data?.categorySuggestions) ? data.categorySuggestions : [];
    const suggestions = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const cat = s.category ?? s;
      const id = cat?.categoryId ?? cat?.id ?? null;
      const name = cat?.categoryName ?? cat?.name ?? null;
      if (id == null || !name || !String(name).trim()) continue;
      const leafFlag = s.leafCategoryTreeNode ?? cat?.leafCategoryTreeNode ?? null;
      if (leafFlag === false) continue; // Không phải leaf thì bỏ — eBay chỉ nhận leaf.
      suggestions.push({
        id: String(id),
        name: String(name).trim(),
        path: suggestionPath(s, String(name).trim()),
        leaf: leafFlag === true ? true : null,
      });
    }
    cachePut(this.suggestionCache, cacheKey, suggestions);
    return suggestions.slice(0, limit);
  }

  async getCategoryNode(categoryId) {
    const id = categoryIdText(categoryId);
    const cfg = this.getEffectiveConfig();
    const treeId = await this.getDefaultCategoryTreeId();
    const cacheKey = `${cfg.environment}|${cfg.marketplaceId}|${treeId}|${id}`;
    const cached = this.categoryNodeCache.get(cacheKey);
    if (cached) return cached;
    const data = await this.taxonomyGet(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree?category_id=${encodeURIComponent(id)}`);
    const node = data?.categorySubtreeNode;
    if (!node || String(node.category?.categoryId ?? '') !== id
      || (data.categoryTreeId != null && String(data.categoryTreeId) !== treeId)) {
      throw new EbayTaxonomyError('ebay_api_error', 'eBay trả cây danh mục không khớp Category ID đã yêu cầu.');
    }
    const result = { node, treeId, treeVersion: data.categoryTreeVersion ?? null };
    cachePut(this.categoryNodeCache, cacheKey, result);
    return result;
  }

  /** Kiểm tra đúng category được hỏi; không suy đoán leaf từ dữ liệu thiếu. */
  async isLeafCategory(categoryId) {
    const { node } = await this.getCategoryNode(categoryId);
    if (node.leafCategoryTreeNode === true) return true;
    if (node.leafCategoryTreeNode === false || node.childCategoryTreeNodes?.length) return false;
    return null;
  }

  /** Tra trực tiếp mã đã biết, không đổi sang danh mục khác bằng từ khoá. */
  async getCategoryDetails(categoryId) {
    const id = categoryIdText(categoryId);
    const cfg = this.getEffectiveConfig();
    const { node, treeId, treeVersion } = await this.getCategoryNode(id);
    if (node.leafCategoryTreeNode !== true || node.childCategoryTreeNodes?.length) {
      throw new EbayTaxonomyError('ebay_category_not_leaf', 'Category ID này chưa được xác nhận là danh mục cuối (leaf) để listing. Hãy chọn danh mục con cụ thể.');
    }
    const name = String(node.category?.categoryName ?? '').trim();
    if (!name) throw new EbayTaxonomyError('ebay_api_error', 'eBay không trả tên danh mục cho Category ID này.');
    let categoryPath = name;
    let categoryPathComplete = node.categoryTreeNodeLevel === 1;
    const prefix = `${cfg.environment}|${cfg.marketplaceId}|`;
    for (const [key, suggestions] of this.suggestionCache) {
      if (!key.startsWith(prefix)) continue;
      const found = suggestions.find((s) => s.id === id && s.path);
      if (found) {
        categoryPath = found.path;
        categoryPathComplete = categoryPathComplete || found.path.includes(' > ');
        break;
      }
    }
    const aspects = await this.getItemAspects(id);
    return {
      categoryId: id, categoryName: name, categoryPath, categoryPathComplete,
      categoryTreeId: treeId, categoryTreeVersion: treeVersion,
      marketplace: cfg.marketplaceId, environment: cfg.environment,
      verifiedFromEbay: true, ...aspects, warning: null,
    };
  }

  /**
   * Trường của một danh mục (getItemAspects). Trả { requiredAspects:
   * [{name, values}], recommendedAspects: [{name, values}] } — values là
   * các giá trị cho phép eBay trả về (có thể rỗng khi eBay không liệt kê).
   * Cache theo categoryId.
   */
  async getItemAspects(categoryId) {
    const id = categoryIdText(categoryId);
    const cfg = this.getEffectiveConfig();
    const treeId = await this.getDefaultCategoryTreeId();
    const cacheKey = `${cfg.environment}|${cfg.marketplaceId}|${treeId}|${id}`;
    const cached = this.aspectsCache.get(cacheKey);
    if (cached) return cached;
    const data = await this.taxonomyGet(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(id)}`);
    const raw = Array.isArray(data?.aspects) ? data.aspects : [];
    const requiredAspects = [];
    const recommendedAspects = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const name = String(a.localizedAspectName ?? a.aspectName ?? a.name ?? '').trim();
      if (!name) continue;
      const constraint = a.aspectConstraint && typeof a.aspectConstraint === 'object' && !Array.isArray(a.aspectConstraint)
        ? structuredClone(a.aspectConstraint) : {};
      // aspectUsage is RECOMMENDED even for required fields in eBay's API.
      const required = constraint.aspectRequired === true;
      const aspectValues = (Array.isArray(a.aspectValues) ? a.aspectValues : [])
        .filter((v) => v && typeof v === 'object' && !Array.isArray(v)).map((v) => structuredClone(v));
      const values = [...new Set(
        aspectValues
          .map((v) => String(v?.localizedValue ?? v?.value ?? '').trim()).filter(Boolean),
      )];
      (required ? requiredAspects : recommendedAspects).push({ name, values, aspectConstraint: constraint, aspectValues });
    }
    const result = { requiredAspects, recommendedAspects };
    cachePut(this.aspectsCache, cacheKey, result);
    return result;
  }

  /**
   * Tra mã cho nhiều nhóm cùng lúc. Mỗi nhóm: gọi getCategorySuggestions
   * bằng từ khoá từ label + tên mẫu, chọn gợi ý đầu tiên là leaf (ưu tiên
   * gợi ý có đường dẫn chứa từ khoá chính xác), kiểm tra lại leaf bằng
   * getCategorySubtree khi eBay không kèm cờ leaf, rồi gọi getItemAspects
   * lấy trường bắt buộc/khuyến nghị.
   * Trả { results: [{groupKey, categoryId, categoryName, categoryPath,
   *   verifiedFromEbay, requiredAspects, recommendedAspects, warning}],
   *   warnings } — nhóm nào không tra được mã thì categoryId=null +
   *   warning, giữ nguyên file nháp như v7, KHÔNG bịa mã.
   * Lỗi xác thực (chưa có khóa / khóa sai) thì throw — endpoint trả lỗi rõ.
   */
  async resolveGroups(groups, opts = {}) {
    const list = (groups ?? []).filter((g) => g && typeof g === 'object' && (g.groupKey ?? g.key));
    if (!list.length) throw new EbayTaxonomyError('groups_required', 'Cần danh sách nhóm để tra mã danh mục.');
    if (list.length > EBAY_RESOLVE_MAX_GROUPS) {
      throw new EbayTaxonomyError('too_many_groups', `Tối đa ${EBAY_RESOLVE_MAX_GROUPS} nhóm mỗi lần tra mã.`);
    }
    const cfg = this.getEffectiveConfig();
    if (!cfg.appId || !cfg.certId) {
      throw new EbayTaxonomyError('ebay_not_configured', 'Chưa có khóa eBay (App ID + Cert ID) — đăng ký tài khoản eBay Developers rồi dán khóa vào tab eBay Taxonomy, hoặc đặt EBAY_APP_ID / EBAY_CERT_ID trong .env.');
    }
    const results = [];
    const warnings = [];
    for (const g of list) {
      const groupKey = String(g.groupKey ?? g.key ?? '').trim();
      const label = String(g.label ?? g.groupLabel ?? groupKey).trim();
      const sampleTitles = Array.isArray(g.sampleTitles) ? g.sampleTitles.filter(Boolean).slice(0, 3) : [];
      const query = buildGroupQuery(label, sampleTitles);
      try {
        const suggestions = await this.getCategorySuggestions(query, { limit: 5 });
        if (!suggestions.length) {
          const warning = `eBay không gợi ý được danh mục cho nhóm "${label}" (từ khoá "${query}") — nhóm giữ file nháp, kiểm tra tên danh mục ở Seller Hub.`;
          warnings.push(warning);
          results.push({ groupKey, categoryId: null, categoryName: null, categoryPath: null, verifiedFromEbay: false, requiredAspects: [], recommendedAspects: [], warning });
          continue;
        }
        // Ưu tiên gợi ý có đường dẫn chứa từ khoá chính xác (vd "Table
        // Lamps" trong path), rồi mới lấy gợi ý đầu tiên.
        const qLower = query.toLowerCase();
        const ranked = [...suggestions].sort((a, b) => {
          const aHit = (a.path || a.name || '').toLowerCase().includes(qLower) ? 0 : 1;
          const bHit = (b.path || b.name || '').toLowerCase().includes(qLower) ? 0 : 1;
          return aHit - bHit;
        });
        let chosen = null;
        for (const s of ranked) {
          if (s.leaf === true) { chosen = s; break; }
          if (s.leaf === null) {
            const isLeaf = await this.isLeafCategory(s.id);
            if (isLeaf === true) { chosen = { ...s, leaf: true }; break; }
            if (isLeaf === false) continue;
            // eBay không xác nhận được leaf: không dùng gợi ý này.
            continue;
          }
        }
        if (!chosen) {
          const warning = `eBay gợi ý ${suggestions.length} danh mục cho nhóm "${label}" nhưng không có danh mục nào là leaf (eBay chỉ nhận leaf) — nhóm giữ file nháp, kiểm tra tên danh mục ở Seller Hub.`;
          warnings.push(warning);
          results.push({ groupKey, categoryId: null, categoryName: null, categoryPath: null, verifiedFromEbay: false, requiredAspects: [], recommendedAspects: [], warning });
          continue;
        }
        const aspects = await this.getItemAspects(chosen.id);
        results.push({
          groupKey,
          categoryId: chosen.id,
          categoryName: chosen.name,
          categoryPath: chosen.path || null,
          verifiedFromEbay: true,
          requiredAspects: aspects.requiredAspects,
          recommendedAspects: aspects.recommendedAspects,
          warning: null,
        });
      } catch (e) {
        if (e instanceof EbayTaxonomyError && (e.code === 'ebay_not_configured' || e.code === 'ebay_auth_failed')) throw e;
        if (isEbayRateLimitError(e)) {
          warnings.push(`eBay chạm giới hạn request (HTTP 429) khi tra mã nhóm "${label}" — đợi 1 phút rồi bấm "Tra mã cho tất cả nhóm" lại, nhóm này giữ file nháp.`);
          results.push({ groupKey, categoryId: null, categoryName: null, categoryPath: null, verifiedFromEbay: false, requiredAspects: [], recommendedAspects: [], warning: 'eBay chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại.' });
          continue;
        }
        const reason = e?.message ? String(e.message) : 'lỗi không rõ';
        warnings.push(`Tra mã nhóm "${label}" lỗi (${reason}) — nhóm giữ file nháp.`);
        results.push({ groupKey, categoryId: null, categoryName: null, categoryPath: null, verifiedFromEbay: false, requiredAspects: [], recommendedAspects: [], warning: reason });
      }
    }
    return { results, warnings };
  }
}

/** Từ khoá tra danh mục cho một nhóm: ưu tiên label nhóm (vd "Table
 *  Lamps"), nếu label là slug/mã nhóm thì lấy từ trong tên mẫu đầu tiên
 *  (vd "Soho Home Archie Table Lamp" -> "Table Lamp"). */
export function buildGroupQuery(label, sampleTitles = []) {
  const cleanLabel = String(label ?? '').trim();
  // Label đã là tên danh mục đọc được (không phải slug/key kỹ thuật) thì
  // dùng thẳng — vd "Table Lamps", "Wall Mirrors".
  if (cleanLabel && !/^[a-z0-9-]+$/.test(cleanLabel) && cleanLabel.length >= 3) return cleanLabel;
  for (const title of sampleTitles ?? []) {
    const t = String(title ?? '').replace(/^soho home\s+/i, '').trim();
    if (!t) continue;
    // Bỏ tên riêng ở đầu (vd "Archie", "Renato"), giữ cụm loại sản phẩm.
    const m = t.match(/(table lamp|wall light|wall mirror|floor lamp|flush light|toilet roll holder|towel rack|toilet brush|armchair|bedside table|dresser|robe|cushion|pillow|rug|mirror|lamp|light|chair|table|bin|robe)/i);
    if (m) return m[1].replace(/\b\w/g, (c) => c.toUpperCase());
    const words = t.split(/\s+/).slice(-2).join(' ');
    if (words) return words;
  }
  return cleanLabel || 'home decor';
}

/** Singleton dùng chung cho dev-server và Workers. */
export const defaultEbayTaxonomyRuntime = new EbayTaxonomyRuntime();

export function applyEnvToEbayRuntime(runtime, env) {
  return runtime.applyEnv(env);
}

export default { EbayTaxonomyRuntime, defaultEbayTaxonomyRuntime, buildGroupQuery };
