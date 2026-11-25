// server/ebay-browse.mjs — Tìm listing eBay khớp + lấy số liệu BÁN/XEM tự
// động bằng eBay Browse API (v9.1). KHÔNG nhập tay link listing, KHÔNG nhập
// tay số người theo dõi, KHÔNG cào WatchCount (robots.txt của họ cấm bot,
// không có API công khai).
//
// Luồng: search theo tên sản phẩm -> chấm điểm ứng viên (trùng tiêu đề +
// gần giá) -> getItem lấy watchCount + estimatedAvailabilities (số đã bán
// ƯỚC TÍNH). Chỉ nhận ứng viên đạt ngưỡng EBAY_MATCH_MIN_SCORE (0,50);
// không có ứng viên đạt ngưỡng thì KHÔNG gán bừa — trả matched:false +
// warning rõ. Số đã bán / người theo dõi là TỔNG cả listing, không chia
// theo màu/size (eBay không công bố số theo biến thể ở bất kỳ nguồn công
// khai nào).
//
// Xác thực: DÙNG CHUNG App ID + Cert ID đã cấu hình cho Taxonomy (ưu tiên
// env rồi khóa dán trong web, RAM-only) và application token của
// EbayTaxonomyRuntime — Browse API dùng client credentials grant giống
// Taxonomy, KHÔNG cần seller consent hay user token. Token cache + làm
// mới khi 401 nằm ở taxonomy runtime; module này chỉ mượn
// getApplicationToken / baseUrl / fetchFn của nó.
//
// Tài liệu chính thức (đã đối chiếu 16/11/2026):
// - Browse API getItem (developer.ebay.com/api-docs/buy/browse/resources/
//   item/methods/getItem): "All methods in the Browse API require an
//   Application access token, which is obtained using the client
//   credentials grant flow."
// - Browse API Item type (developer.ebay.com/api-docs/buy/browse/types/
//   gct:Item): có field watchCount và estimatedAvailabilities — "The
//   estimated number of this item that are available for purchase. Because
//   the quantity of an item can change several times within a second, it is
//   impossible to return the exact quantity. So instead of returning
//   quantity, the estimated availability of the item is returned."
//   estimatedAvailabilities mang estimatedSoldQuantity +
//   estimatedRemainingQuantity (thay cho QuantitySold của Shopping API đã
//   nghỉ — SDK Browse API ghi rõ điều này).
// - GET /buy/browse/v1/item_summary/search?q=<từ khoá> (search) và
//   GET /buy/browse/v1/item/{item_id} (getItem), GET /buy/browse/v1/item/
//   get_item_by_legacy_id?legacy_item_id=<id> mở cho mọi tài khoản có khóa
//   eBay Developers. RIÊNG GET /buy/browse/v1/item (getItems, bulk) là
//   limited-release chỉ dành cho đối tác chọn lọc (cần scope
//   buy.item.bulk riêng) nên KHÔNG dùng — v9.1 chỉ gọi từng item một.
// - Mọi gọi Browse API cần header X-EBAY-C-MARKETPLACE-ID (vd EBAY_US).
// - Giới hạn Browse API khoảng 5.000 calls/ngày: search + getItem = 2
//   calls/sản phẩm; bulk enrich giãn 200ms giữa các sản phẩm và dừng khi
//   gặp 429 (stopped429), đợi 1 phút rồi bấm lại.

import {
  EbayTaxonomyError,
  fetchWithTimeout,
  isEbayRateLimitError,
  defaultEbayTaxonomyRuntime,
  EBAY_TIMEOUT_MS,
  EBAY_CACHE_MAX_ENTRIES,
} from './ebay-taxonomy.mjs';

/** Base path Browse API (nối sau baseUrl production/sandbox). */
export const EBAY_BROWSE_BASE_PATH = '/buy/browse/v1';
/** Số ứng viên tối đa lấy về khi search theo tên sản phẩm. */
export const EBAY_BROWSE_SEARCH_LIMIT = 10;
/** Điểm khớp tối thiểu để nhận 1 listing (0–1). Dưới ngưỡng thì không gán. */
export const EBAY_MATCH_MIN_SCORE = 0.5;
/** Giãn giữa các sản phẩm khi enrich hàng loạt (Browse API ~5.000 calls/ngày). */
export const EBAY_BROWSE_BULK_DELAY_MS = 200;
/** Số đã bán / người theo dõi thay đổi theo thời gian: cache Browse chỉ giữ
 *  10 phút (trước đây giữ suốt đời process, "Tìm lại" luôn trả số cũ). */
export const EBAY_BROWSE_CACHE_TTL_MS = 10 * 60 * 1000;

function cachePut(map, key, value) {
  if (map.size >= EBAY_CACHE_MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, { value, at: Date.now() });
}

function cacheGet(map, key, now = Date.now()) {
  const hit = map.get(key);
  if (!hit) return null;
  if (now - hit.at > EBAY_BROWSE_CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

/** Từ dừng khi tách tiêu đề thành từ khoá (không mang nghĩa phân biệt). */
const EBAY_MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'of', 'a', 'an', 'in', 'on', 'us', 'set', 'new', 'pcs', 'pc']);
/** Từ loại sản phẩm chung chung — trùng từ này không chứng tỏ cùng sản phẩm
 *  (vd "Square Cushion" trùng nhau ở mọi gối). Chỉ dùng để xác định từ
 *  PHÂN BIỆT (vd "Daxton", "Renato"): ứng viên phải chứa ít nhất 1 từ
 *  phân biệt của tiêu đề gốc, nếu không điểm khớp = 0. */
const EBAY_MATCH_GENERIC = new Set([
  'square', 'round', 'cushion', 'pillow', 'cover', 'throw', 'lamp', 'light',
  'mirror', 'table', 'chair', 'rug', 'robe', 'linen', 'velvet', 'cotton',
  'brass', 'marble', 'black', 'white', 'large', 'small', 'medium', 'extra',
  'floor', 'wall', 'ceiling', 'bedside', 'dresser', 'towel', 'toilet',
  'roll', 'holder', 'brush', 'armchair', 'sham', 'bolster', 'sofa', 'seat',
  'bench', 'lumbar', 'plush', 'decorative', 'print', 'solid', 'plain',
]);

/**
 * Chuẩn hoá tiêu đề để so khớp: lowercase, bỏ "soho home" ở đầu, bỏ ký tự
 * đặc biệt, gộp khoảng trắng. "Soho Home Daxton Square Cushion" ->
 * "daxton square cushion".
 */
export function normalizeEbayTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/^soho home\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tách tiêu đề thành các từ khoá có nghĩa (bỏ từ dừng, từ 1 ký tự). */
export function ebayTitleTokens(title) {
  return normalizeEbayTitle(title)
    .split(' ')
    .filter((w) => w && w.length > 1 && !EBAY_MATCH_STOPWORDS.has(w));
}

/**
 * Từ khoá search cho Browse API: các từ khoá của tiêu đề gốc, tối đa 8 từ.
 * "Soho Home Daxton Square Cushion Olive" -> "daxton square cushion olive".
 * Trả '' khi tiêu đề rỗng/không có từ khoá.
 */
export function buildSearchQuery(title) {
  return ebayTitleTokens(title).slice(0, 8).join(' ');
}

/**
 * Chấm điểm ứng viên eBay so với sản phẩm gốc (0–1):
 * - Tỉ lệ từ khoá của tiêu đề gốc xuất hiện trong tiêu đề ứng viên.
 * - Ứng viên không chứa từ PHÂN BIỆT nào (từ dài >= 4 ký tự, không phải
 *   từ loại chung chung) thì điểm = 0 — tránh gán nhầm "Halsey Square
 *   Cushion" cho "Daxton Square Cushion" chỉ vì trùng "Square Cushion".
 * - Cộng thêm tối đa 0,15 khi giá listing gần giá bán lẻ (<=15%: +0,15;
 *   <=35%: +0,10); giá lệch nhiều thì KHÔNG trừ điểm vì giá bán eBay
 *   thường thấp hơn giá bán lẻ (vd COST $395 -> GIÁ BÁN $280).
 * Điểm >= EBAY_MATCH_MIN_SCORE (0,50) mới được nhận.
 */
export function scoreEbayMatch(product, candidate) {
  const pTokens = ebayTitleTokens(product?.title ?? product?.edits?.title ?? '');
  if (!pTokens.length) return 0;
  const cSet = new Set(ebayTitleTokens(candidate?.title ?? ''));
  const distinctive = pTokens.filter((t) => t.length >= 4 && !EBAY_MATCH_GENERIC.has(t));
  if (distinctive.length && !distinctive.some((t) => cSet.has(t))) return 0;
  const matched = pTokens.filter((t) => cSet.has(t)).length;
  let score = matched / pTokens.length;
  const pp = Number(product?.price);
  const cp = Number(candidate?.price?.value ?? candidate?.price);
  if (Number.isFinite(pp) && pp > 0 && Number.isFinite(cp) && cp > 0) {
    const diff = Math.abs(pp - cp) / Math.max(pp, cp);
    if (diff <= 0.15) score += 0.15;
    else if (diff <= 0.35) score += 0.1;
  }
  return Math.max(0, Math.min(1, score));
}

export class EbayBrowseRuntime {
  /**
   * @param {object} taxonomyRuntime — EbayTaxonomyRuntime dùng chung
   * (mặc định singleton). Module này mượn token + baseUrl + fetchFn của
   * nó nên khóa eBay chỉ cấu hình 1 chỗ (tab eBay Taxonomy).
   */
  constructor(taxonomyRuntime = defaultEbayTaxonomyRuntime) {
    this.taxonomy = taxonomyRuntime;
    this.searchCache = new Map(); // query -> candidates
    this.itemCache = new Map(); // itemId -> details
  }

  /** Trạng thái khóa eBay (ủy quyền cho taxonomy runtime). */
  getStatus() {
    return this.taxonomy.getStatus();
  }

  /** Base URL theo môi trường (production mặc định, sandbox dùng khóa riêng). */
  baseUrl() {
    return this.taxonomy.baseUrl();
  }

  /**
   * GET một endpoint Browse đã xác thực. Token hết hạn (401) thì làm mới
   * 1 lần rồi thử lại; vẫn lỗi thì trả lỗi rõ. Không log token/key.
   * Mọi gọi Browse API cần header X-EBAY-C-MARKETPLACE-ID.
   */
  async browseGet(path, { forceRefreshToken = false } = {}) {
    const token = await this.taxonomy.getApplicationToken({ forceRefresh: forceRefreshToken });
    const cfg = this.taxonomy.getEffectiveConfig();
    let res;
    try {
      res = await fetchWithTimeout(`${this.baseUrl()}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': cfg.marketplaceId,
        },
      }, this.taxonomy.fetchFn, EBAY_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof EbayTaxonomyError) throw e;
      throw new EbayTaxonomyError('ebay_connection_failed', `Không kết nối được eBay (${e?.message ?? 'lỗi mạng'}) — kiểm tra mạng rồi thử lại.`);
    }
    if (res.status === 401 && !forceRefreshToken) {
      return this.browseGet(path, { forceRefreshToken: true });
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new EbayTaxonomyError('ebay_rate_limit', 'eBay chạm giới hạn request (HTTP 429) — đợi 1 phút rồi thử lại.');
      }
      if (res.status === 404) {
        throw new EbayTaxonomyError('ebay_not_found', `eBay không tìm thấy dữ liệu (HTTP 404) cho ${path} — listing có thể đã kết thúc, thử tra lại.`);
      }
      throw new EbayTaxonomyError('ebay_api_error', `eBay lỗi (HTTP ${res.status}) khi gọi ${path}.`);
    }
    return res.json().catch(() => ({}));
  }

  /** Phạm vi cache: môi trường + marketplace. Đổi sandbox↔production hoặc
   *  marketplace qua /api/ebay/config thì không dùng lại kết quả cũ. */
  cacheScope() {
    const cfg = this.taxonomy.getEffectiveConfig?.() ?? {};
    return `${cfg.environment ?? ''}|${cfg.marketplaceId ?? ''}`;
  }

  /**
   * Tìm listing eBay theo tên sản phẩm (item_summary/search).
   * Trả [{itemId, legacyItemId, title, price: {value, currency}, itemWebUrl}]
   * (tối đa limit, mặc định 10). Không có kết quả thì [] — không lỗi.
   * fresh: bỏ qua cache (seller bấm "Tìm lại").
   */
  async searchItemsByTitle(title, { limit = EBAY_BROWSE_SEARCH_LIMIT, fresh = false } = {}) {
    const q = buildSearchQuery(title);
    if (!q) return [];
    const cacheKey = `${this.cacheScope()}|${q.toLowerCase()}`;
    const cached = fresh ? null : cacheGet(this.searchCache, cacheKey);
    if (cached) return cached.slice(0, limit);
    const data = await this.browseGet(`${EBAY_BROWSE_BASE_PATH}/item_summary/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`);
    const raw = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
    const items = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const itemId = s.itemId ? String(s.itemId) : null;
      const itemTitle = s.title ? String(s.title).trim() : '';
      if (!itemId || !itemTitle) continue;
      items.push({
        itemId,
        legacyItemId: s.legacyItemId != null ? String(s.legacyItemId) : null,
        title: itemTitle,
        price: s.price?.value != null
          ? { value: Number(s.price.value), currency: s.price.currency ?? 'USD' }
          : null,
        itemWebUrl: s.itemWebUrl ? String(s.itemWebUrl) : null,
      });
    }
    cachePut(this.searchCache, cacheKey, items);
    return items.slice(0, limit);
  }

  /**
   * Chi tiết 1 listing (getItem): watchCount + estimatedAvailabilities.
   * Trả {itemId, legacyItemId, title, price, currency, watchCount,
   * estimatedSoldQuantity, estimatedRemainingQuantity, itemWebUrl}.
   * estimatedSoldQuantity là số eBay ƯỚC TÍNH (cộng dồn các mục
   * estimatedAvailabilities), không phải số chính xác tuyệt đối; không có
   * thì null. watchCount không có thì null.
   */
  async getItemDetails(itemId, { fresh = false } = {}) {
    const id = String(itemId ?? '').trim();
    if (!id) throw new EbayTaxonomyError('item_required', 'Cần mã item eBay để lấy chi tiết listing.');
    const key = `${this.cacheScope()}|${id}`;
    const cached = fresh ? null : cacheGet(this.itemCache, key);
    if (cached) return cached;
    const data = await this.browseGet(`${EBAY_BROWSE_BASE_PATH}/item/${encodeURIComponent(id)}`);
    const details = parseBrowseItem(data, id);
    cachePut(this.itemCache, key, details);
    return details;
  }

  /**
   * Chi tiết 1 listing bằng mã số item cũ (số, vd 123456789012) qua
   * get_item_by_legacy_id — dùng khi seller sửa tay mã item trong form
   * chi tiết sản phẩm. Trả cùng shape với getItemDetails.
   */
  async getItemByLegacyId(legacyItemId, { fresh = false } = {}) {
    const id = String(legacyItemId ?? '').trim();
    if (!id) throw new EbayTaxonomyError('item_required', 'Cần mã số item eBay để lấy chi tiết listing.');
    const scope = this.cacheScope();
    const cached = fresh ? null : cacheGet(this.itemCache, `${scope}|legacy:${id}`);
    if (cached) return cached;
    const data = await this.browseGet(`${EBAY_BROWSE_BASE_PATH}/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(id)}`);
    const details = parseBrowseItem(data, data?.itemId ?? id);
    cachePut(this.itemCache, `${scope}|legacy:${id}`, details);
    if (details.itemId) cachePut(this.itemCache, `${scope}|${details.itemId}`, details);
    return details;
  }

  /**
   * Tìm listing eBay khớp cho 1 sản phẩm rồi lấy số liệu của listing đó.
   * KHÔNG BAO GIỜ throw vì không tìm thấy / không khớp — trả matched:false
   * + warning để luồng chính (extract-page, enrich-all) tiếp tục chạy.
   * Chỉ trả code ebay_not_configured / ebay_auth_failed để endpoint thủ
   * công (/api/ebay/enrich) báo lỗi rõ cho team.
   * Trả {matched, itemId, legacyItemId, itemTitle, itemUrl, sold, watchers,
   * score, warning, stopped429, code, source: 'browse-api'}.
   * - forceItemId: bỏ qua bước search, lấy thẳng listing đó (seller sửa
   *   tay mã item trong form chi tiết) — mã số thì dùng getItemByLegacyId,
   *   mã REST (v1|...|0) thì dùng getItemDetails; điểm khớp = 1.
   * - fresh: bỏ qua cache, tra lại từ eBay (nút "Tìm lại" / sửa tay).
   */
  async enrichProduct(product, { forceItemId, fresh = false } = {}) {
    const source = 'browse-api';
    const cfg = this.taxonomy.getEffectiveConfig();
    if (!cfg.appId || !cfg.certId) {
      return {
        matched: false, code: 'ebay_not_configured', source,
        warning: 'Chưa có khóa eBay (App ID + Cert ID) — chưa tìm listing eBay khớp. Dán khóa trong tab AI gợi ý (mục eBay Taxonomy) rồi bấm "Tìm lại".',
      };
    }
    try {
      // Seller chỉ định thẳng 1 listing (sửa tay mã item khi khớp sai).
      const forced = String(forceItemId ?? '').trim();
      if (forced) {
        const details = /^\d{9,}$/.test(forced)
          ? await this.getItemByLegacyId(forced, { fresh })
          : await this.getItemDetails(forced, { fresh });
        return {
          matched: true, score: 1, source,
          itemId: details.itemId,
          legacyItemId: details.legacyItemId ?? (/^\d{9,}$/.test(forced) ? forced : null),
          itemTitle: details.title,
          itemUrl: details.itemWebUrl,
          sold: details.estimatedSoldQuantity,
          watchers: details.watchCount,
          warning: details.estimatedSoldQuantity == null
            ? 'Listing khớp nhưng eBay không trả số đã bán cho listing này — số đã bán để trống.'
            : null,
        };
      }
      const title = String(product?.edits?.title ?? product?.title ?? '').trim();
      if (!title) {
        return { matched: false, source, warning: 'Sản phẩm chưa có tiêu đề nên không tìm được listing eBay khớp.' };
      }
      const candidates = await this.searchItemsByTitle(title, { fresh });
      if (!candidates.length) {
        return { matched: false, source, warning: `Không tìm thấy listing eBay nào cho "${title}" — số đã bán / người theo dõi để trống, bấm "Tìm lại" sau khi đổi tên.` };
      }
      let best = null;
      let bestScore = 0;
      for (const c of candidates) {
        const s = scoreEbayMatch(product, c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (!best || bestScore < EBAY_MATCH_MIN_SCORE) {
        return {
          matched: false, bestScore, source,
          warning: `Tìm thấy ${candidates.length} listing nhưng không có listing nào khớp đủ (điểm cao nhất ${bestScore.toFixed(2)} < ${EBAY_MATCH_MIN_SCORE.toFixed(2)}) — số đã bán / người theo dõi để trống, không gán bừa.`,
        };
      }
      const details = await this.getItemDetails(best.itemId, { fresh });
      return {
        matched: true, score: bestScore, source,
        itemId: details.itemId,
        legacyItemId: details.legacyItemId ?? best.legacyItemId ?? null,
        itemTitle: details.title ?? best.title,
        itemUrl: details.itemWebUrl ?? best.itemWebUrl,
        sold: details.estimatedSoldQuantity,
        watchers: details.watchCount,
        warning: details.estimatedSoldQuantity == null
          ? 'Listing khớp nhưng eBay không trả số đã bán cho listing này — số đã bán để trống.'
          : null,
      };
    } catch (e) {
      if (e instanceof EbayTaxonomyError && (e.code === 'ebay_not_configured' || e.code === 'ebay_auth_failed')) {
        return { matched: false, code: e.code, source, warning: e.message };
      }
      if (isEbayRateLimitError(e)) {
        return { matched: false, stopped429: true, source, warning: 'eBay chạm giới hạn request (HTTP 429) — đợi 1 phút rồi bấm "Tìm lại" / "Tìm listing eBay cho tất cả sản phẩm chưa có số liệu" lại.' };
      }
      const reason = e?.message ? String(e.message) : 'lỗi không rõ';
      return { matched: false, source, warning: `Tìm listing eBay lỗi (${reason}) — số đã bán / người theo dõi để trống.` };
    }
  }
}

/**
 * Parse response getItem / get_item_by_legacy_id (Item): cộng dồn
 * estimatedSoldQuantity / estimatedRemainingQuantity qua các mục
 * estimatedAvailabilities (listing nhiều biến thể có nhiều mục).
 */
function parseBrowseItem(data, fallbackId) {
  const d = (data && typeof data === 'object') ? data : {};
  const avail = Array.isArray(d.estimatedAvailabilities) ? d.estimatedAvailabilities : [];
  let sold = null;
  let remaining = null;
  for (const a of avail) {
    if (!a || typeof a !== 'object') continue;
    const s = Number(a.estimatedSoldQuantity);
    if (Number.isInteger(s) && s >= 0) sold = (sold ?? 0) + s;
    const r = Number(a.estimatedRemainingQuantity);
    if (Number.isInteger(r) && r >= 0) remaining = (remaining ?? 0) + r;
  }
  const price = d.price?.value != null ? { value: Number(d.price.value), currency: d.price.currency ?? 'USD' } : null;
  const watch = Number(d.watchCount);
  return {
    itemId: d.itemId ? String(d.itemId) : String(fallbackId ?? ''),
    legacyItemId: d.legacyItemId != null ? String(d.legacyItemId) : null,
    title: d.title ? String(d.title).trim() : null,
    price,
    currency: price?.currency ?? 'USD',
    watchCount: Number.isInteger(watch) && watch >= 0 ? watch : null,
    estimatedSoldQuantity: sold,
    estimatedRemainingQuantity: remaining,
    itemWebUrl: d.itemWebUrl ? String(d.itemWebUrl) : null,
  };
}

/** Singleton dùng chung cho dev-server và Workers (chung khóa Taxonomy). */
export const defaultEbayBrowseRuntime = new EbayBrowseRuntime();

export default { EbayBrowseRuntime, defaultEbayBrowseRuntime, scoreEbayMatch, buildSearchQuery, normalizeEbayTitle, ebayTitleTokens };
