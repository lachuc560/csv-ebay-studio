// server/api.mjs — Backend API cho CSV Listing eBay.
// Pure handler (handleRequest) dùng chung cho dev server (Node, MemoryStore)
// và Cloudflare Workers (D1Store). Không dùng fetch/Request trong handleRequest.
// Mọi response JSON đều có Content-Type: application/json ở lớp transport
// (Workers fetch / dev-server), vì popup extension coi response không phải JSON
// là lỗi access_blocked.
//
// Contract khớp extension Chrome v1.0.0 (dist/popup.js):
//   GET  /api/ingest/ping            Bearer csvk_... -> 200 {ok, name}; sai -> 401 {error:"invalid_api_key"}
//   POST /api/ingest/records        {records:[...]} -> 200 {ok, updated, products:[summary], stats}
//        summary: {id, title, variants, inStock, images, currency, priceEstimated, price}
//        lỗi: invalid_api_key | records_required | invalid_records | invalid_products
//             | body_too_large | too_many_records | server_error

import Core from '../public/core.js';
import { suggestWithRuntime, groupWithRuntime, suggestDraftCategoriesWithRuntime, extractPageWithRuntime, extractPagesWithRuntime, extractPageRecord } from './ai.mjs';
import { defaultAiRuntime, applyEnvToRuntime } from './ai-providers.mjs';
import { defaultEbayTaxonomyRuntime, applyEnvToEbayRuntime, EbayTaxonomyError, EBAY_RESOLVE_MAX_GROUPS } from './ebay-taxonomy.mjs';
import { defaultEbayBrowseRuntime } from './ebay-browse.mjs';
import { defaultCloudflareImagesRuntime, applyEnvToImagesRuntime } from './cloudflare-images.mjs';

export const MAX_BODY_BYTES = 6_000_000;
export const MAX_RECORDS_PER_REQUEST = 200;
export const MAX_CRAWL_ERRORS = 500;
export const MAX_CRAWL_ERRORS_RESPONSE = 100;

export const DEFAULT_CONFIG = Object.freeze({
  markupPct: 0.35,
  ebayFeePct: 0.13,
  shippingCost: 0,
  taxPct: 0,
  roundTo99: true,
});

const CONFIG_KEYS = ['markupPct', 'ebayFeePct', 'shippingCost', 'taxPct', 'roundTo99'];
const LISTING_CONFIG_KEYS = ['ebayLocation', 'returnsAcceptedOption', 'returnsWithinOption',
  'refundOption', 'shippingCostPaidByOption', 'shippingProfileName', 'returnProfileName', 'paymentProfileName'];

export class VersionConflict extends Error {
  constructor() { super('version_conflict'); this.code = 'version_conflict'; }
}

// Re-read before retrying so crawls/enrichment cannot overwrite a seller's edits.
async function updateStoredProduct(store, id, transform) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getProduct(id);
    const next = transform(current);
    if (!next) return current;
    try { return await store.putProduct(next, current?.version ?? 0); }
    catch (error) { if (!(error instanceof VersionConflict)) throw error; }
  }
  throw new VersionConflict();
}

// ---- crypto (chạy được cả Node 24 và Workers) ------------------------------

export async function sha256Hex(token) {
  const data = new TextEncoder().encode(String(token));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(nChars) {
  const bytes = new Uint8Array(Math.ceil(nChars / 2));
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, nChars);
}

function newId(prefix) {
  if (typeof globalThis.crypto.randomUUID === 'function') return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${randomHex(12)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---- API keys ----------------------------------------------------------------

export async function createApiKey(store, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw { code: 'name_required' };
  const key = `csvk_${randomHex(32)}`;
  const record = {
    id: newId('key'),
    name: clean,
    key_hash: await sha256Hex(key),
    created_at: nowIso(),
    last_used_at: null,
  };
  await store.createApiKeyRecord(record);
  // Key chỉ hiện một lần lúc tạo; trong store chỉ lưu hash.
  return { id: record.id, name: record.name, key, createdAt: record.created_at };
}

export async function verifyApiKey(store, token) {
  if (typeof token !== 'string' || !token.startsWith('csvk_')) return null;
  const hash = await sha256Hex(token);
  const record = await store.verifyApiKeyRecord(hash);
  return record ?? null;
}

export function publicKey(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    createdAt: record.created_at ?? record.createdAt ?? null,
    lastUsedAt: record.last_used_at ?? record.lastUsedAt ?? null,
  };
}

// ---- MemoryStore (test + dev local) ------------------------------------------

export class MemoryStore {
  constructor() {
    this.products = new Map(); // id -> product
    this.meta = new Map(); // key -> string
    this.apiKeys = new Map(); // id -> {id, name, key_hash, created_at, last_used_at}
    this.crawlErrors = []; // tối đa MAX_CRAWL_ERRORS, cũ nhất bị đẩy ra
  }

  getProduct(id) { return this.products.get(id) ?? null; }
  putProduct(product, expectedVersion) {
    if (expectedVersion !== undefined && (this.products.get(product.id)?.version ?? 0) !== expectedVersion) {
      throw new VersionConflict();
    }
    this.products.set(product.id, product);
    return product;
  }
  listProducts() { return [...this.products.values()]; }

  getMeta(key) { return this.meta.get(key) ?? null; }
  putMeta(key, value) { this.meta.set(key, String(value)); }

  createApiKeyRecord(record) { this.apiKeys.set(record.id, { ...record }); return record; }

  verifyApiKeyRecord(keyHash) {
    for (const record of this.apiKeys.values()) {
      if (record.key_hash === keyHash) {
        record.last_used_at = nowIso();
        return record;
      }
    }
    return null;
  }

  listKeys() { return [...this.apiKeys.values()]; }

  deleteKey(id) { return this.apiKeys.delete(id); }

  listCrawlErrors() { return [...this.crawlErrors]; }

  pushCrawlError(error) {
    const entry = {
      source_site: error?.source_site ?? null,
      source_product_id: error?.source_product_id ?? null,
      message: String(error?.message ?? error ?? 'unknown error'),
      at: error?.at ?? nowIso(),
    };
    this.crawlErrors.push(entry);
    while (this.crawlErrors.length > MAX_CRAWL_ERRORS) this.crawlErrors.shift();
    return entry;
  }

  clearData() {
    this.products.clear();
    this.crawlErrors.length = 0;
    this.meta.delete('config');
  }
}

// ---- D1Store (Cloudflare Workers, binding env.DB) ----------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_site TEXT,
  source_product_id TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source_site, source_product_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`;

// Chạy DDL một lần cho mỗi binding DB (Workers isolate tái sử dụng).
const initializedDbs = new WeakSet();

export class D1Store {
  constructor(env) {
    if (!env || !env.DB) throw new Error('D1Store requires env.DB binding');
    this.db = env.DB;
  }

  async ensureSchema() {
    if (initializedDbs.has(this.db)) return;
    await this.db.exec(DDL);
    initializedDbs.add(this.db);
  }

  async getProduct(id) {
    await this.ensureSchema();
    const row = await this.db.prepare('SELECT data FROM products WHERE id = ?1').bind(id).first();
    return row ? JSON.parse(row.data) : null;
  }

  async putProduct(product, expectedVersion) {
    await this.ensureSchema();
    if (expectedVersion > 0) {
      const result = await this.db.prepare(
        'UPDATE products SET data = ?1, version = ?2, source_site = ?3, source_product_id = ?4, updated_at = ?5 WHERE id = ?6 AND version = ?7',
      ).bind(JSON.stringify(product), product.version, product.source_site ?? null,
        product.source_product_id ?? null, product.updated_at ?? nowIso(), product.id, expectedVersion).run();
      if (!result.meta?.changes) throw new VersionConflict();
      return product;
    }
    const result = await this.db.prepare(
      `INSERT INTO products (id, data, version, source_site, source_product_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ${expectedVersion === 0 ? 'ON CONFLICT(id) DO NOTHING' : `ON CONFLICT(id) DO UPDATE SET
         data = excluded.data, version = excluded.version,
         source_site = excluded.source_site, source_product_id = excluded.source_product_id,
         updated_at = excluded.updated_at`}`,
    ).bind(
      product.id, JSON.stringify(product), product.version ?? 1,
      product.source_site ?? null, product.source_product_id ?? null,
      product.updated_at ?? nowIso(),
    ).run();
    if (expectedVersion === 0 && !result.meta?.changes) throw new VersionConflict();
    return product;
  }

  async listProducts() {
    await this.ensureSchema();
    const { results } = await this.db.prepare('SELECT data FROM products ORDER BY updated_at DESC').all();
    return (results ?? []).map((r) => JSON.parse(r.data));
  }

  async getMeta(key) {
    await this.ensureSchema();
    const row = await this.db.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first();
    return row ? row.value : null;
  }

  async putMeta(key, value) {
    await this.ensureSchema();
    await this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).bind(key, String(value)).run();
  }

  async createApiKeyRecord(record) {
    await this.ensureSchema();
    await this.db.prepare(
      'INSERT INTO api_keys (id, name, key_hash, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(record.id, record.name, record.key_hash, record.created_at, record.last_used_at).run();
    return record;
  }

  async verifyApiKeyRecord(keyHash) {
    await this.ensureSchema();
    const row = await this.db.prepare(
      'SELECT id, name, key_hash, created_at, last_used_at FROM api_keys WHERE key_hash = ?1',
    ).bind(keyHash).first();
    if (!row) return null;
    const at = nowIso();
    await this.db.prepare('UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2').bind(at, row.id).run();
    return { ...row, last_used_at: at };
  }

  async listKeys() {
    await this.ensureSchema();
    const { results } = await this.db.prepare(
      'SELECT id, name, key_hash, created_at, last_used_at FROM api_keys ORDER BY created_at DESC',
    ).all();
    return results ?? [];
  }

  async deleteKey(id) {
    await this.ensureSchema();
    const res = await this.db.prepare('DELETE FROM api_keys WHERE id = ?1').bind(id).run();
    return (res?.meta?.changes ?? 0) > 0;
  }

  async listCrawlErrors() {
    const raw = await this.getMeta('crawl_errors');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async pushCrawlError(error) {
    const errors = await this.listCrawlErrors();
    const entry = {
      source_site: error?.source_site ?? null,
      source_product_id: error?.source_product_id ?? null,
      message: String(error?.message ?? error ?? 'unknown error'),
      at: error?.at ?? nowIso(),
    };
    errors.push(entry);
    while (errors.length > MAX_CRAWL_ERRORS) errors.shift();
    await this.putMeta('crawl_errors', JSON.stringify(errors));
    return entry;
  }

  async clearData() {
    await this.ensureSchema();
    await this.db.exec("DELETE FROM products; DELETE FROM meta WHERE key IN ('config', 'crawl_errors');");
  }
}

// ---- config ------------------------------------------------------------------

export async function getConfig(store) {
  const raw = await store.getMeta('config');
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function putConfig(store, patch) {
  const current = await getConfig(store);
  const next = { ...current };
  for (const key of CONFIG_KEYS) {
    if (patch[key] === undefined) continue;
    if (key === 'roundTo99') {
      if (![true, false, 'true', 'false'].includes(patch[key])) throw new Error(`invalid_config:${key}`);
      next[key] = patch[key] === true || patch[key] === 'true';
    }
    else {
      const n = Number(patch[key]);
      if (!['number', 'string'].includes(typeof patch[key]) || (typeof patch[key] === 'string' && !patch[key].trim())
        || !Number.isFinite(n) || n < 0 || (key === 'ebayFeePct' && n >= 1)) throw new Error(`invalid_config:${key}`);
      next[key] = n;
    }
  }
  for (const key of LISTING_CONFIG_KEYS) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'string' || patch[key].length > 250) throw new Error(`invalid_config:${key}`);
    next[key] = patch[key].trim();
  }
  if (patch.dispatchTimeMax !== undefined) {
    const days = Number(patch.dispatchTimeMax);
    if (!['number', 'string'].includes(typeof patch.dispatchTimeMax) || (typeof patch.dispatchTimeMax === 'string' && !patch.dispatchTimeMax.trim())
      || !Number.isInteger(days) || days < 0) throw new Error('invalid_config:dispatchTimeMax');
    next.dispatchTimeMax = days;
  }
  if (patch.listingCurrency !== undefined) {
    if (typeof patch.listingCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(patch.listingCurrency)) throw new Error('invalid_config:listingCurrency');
    next.listingCurrency = patch.listingCurrency.toUpperCase();
  }
  if (patch.exchangeRates !== undefined) {
    if (!patch.exchangeRates || typeof patch.exchangeRates !== 'object' || Array.isArray(patch.exchangeRates)) throw new Error('invalid_config:exchangeRates');
    const rates = {};
    for (const [currency, rate] of Object.entries(patch.exchangeRates)) {
      if (!/^[A-Za-z]{3}$/.test(currency) || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('invalid_config:exchangeRates');
      rates[currency.toUpperCase()] = rate;
    }
    next.exchangeRates = rates;
  }
  await store.putMeta('config', JSON.stringify(next));
  return next;
}

// ---- helpers -----------------------------------------------------------------

function bearerToken(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const v = headers.get('authorization') ?? headers.get('Authorization');
    return v && v.startsWith('Bearer ') ? v.slice(7).trim() : null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string' && v.startsWith('Bearer ')) {
      return v.slice(7).trim();
    }
  }
  return null;
}

function ok(status, json) { return { status, json }; }
function err(status, code, extra = {}) { return { status, json: { error: code, ...extra } }; }

/**
 * Lỗi gọi eBay Taxonomy -> response rõ ràng, KHÔNG lộ key/token.
 * ebay_not_configured -> 400; ebay_auth_failed -> 502; chạm giới hạn
 * (429) -> 429; còn lại -> 502. Lỗi khác (không phải eBay) -> 500.
 */
function ebayErrorResponse(e) {
  const code = e?.code ?? '';
  const message = e?.message ? String(e.message) : 'Lỗi gọi eBay Taxonomy.';
  if (e instanceof EbayTaxonomyError) {
    if (code === 'ebay_not_configured') return err(400, 'ebay_not_configured', { message });
    if (code === 'ebay_auth_failed') return err(502, 'ebay_auth_failed', { message });
    if (code === 'ebay_rate_limit') return err(429, 'ebay_rate_limit', { message });
    if (['query_required', 'groups_required', 'too_many_groups', 'invalid_category_id', 'ebay_category_not_leaf'].includes(code)) {
      return err(400, code, { message });
    }
    return err(502, 'ebay_error', { message });
  }
  return err(500, 'server_error');
}

/**
 * Ghi kết quả khớp listing eBay (Browse API, v9.1) vào sản phẩm: mã item,
 * tiêu đề/link listing, số đã bán (ước tính), số người theo dõi, điểm khớp,
 * nguồn 'browse-api'. Chỉ ghi khi matched=true; số đã bán / người theo dõi
 * Browse API không trả (null) thì GIỮ số cũ (không xoá). Tăng version +1.
 * Trả sản phẩm đã lưu.
 */
async function applyBrowseEnrichment(store, product, enrichment) {
  return updateStoredProduct(store, product.id, (current) => {
  if (!current) return null;
  product = current;
  const next = {
    ...product,
    updated_at: nowIso(),
    version: (product.version ?? 1) + 1,
  };
  next.ebayItemId = enrichment.legacyItemId ?? enrichment.itemId ?? product.ebayItemId ?? null;
  next.ebayItemTitle = enrichment.itemTitle ?? product.ebayItemTitle ?? null;
  next.ebayItemUrl = enrichment.itemUrl ?? product.ebayItemUrl ?? null;
  if (enrichment.sold != null) next.ebaySold = enrichment.sold;
  if (enrichment.watchers != null) {
    next.ebayWatchers = enrichment.watchers;
    next.ebayWatchersSource = 'eBay Browse API (tự động)';
  }
  next.ebayMatchScore = enrichment.score ?? null;
  next.ebayMatchSource = enrichment.source ?? 'browse-api';
  return next;
  });
}

/**
 * Tìm listing eBay khớp cho 1 sản phẩm (best-effort, không throw): trả
 * {enrichment, product} — product là bản đã lưu khi khớp, bản gốc khi
 * không khớp / chưa có khóa / lỗi. Luồng chính (extract-page) không bao
 * giờ chết vì bước này.
 */
async function enrichSavedProduct(store, browseRuntime, product) {
  if (!product) return { enrichment: null, product };
  try {
    const enrichment = await browseRuntime.enrichProduct(product);
    if (!enrichment?.matched) return { enrichment, product };
    const saved = await applyBrowseEnrichment(store, product, enrichment);
    return { enrichment, product: saved };
  } catch (e) {
    return {
      enrichment: { matched: false, source: 'browse-api', warning: `Tìm listing eBay lỗi (${e?.message ?? 'lỗi không rõ'}) — số đã bán / người theo dõi để trống.` },
      product,
    };
  }
}

/**
 * Đưa ảnh của 1 sản phẩm lên Cloudflare R2 (v9.1, best-effort): ảnh upload
 * được -> product.images thành link Cloudflare, link gốc giữ trong
 * product.originalImages; ảnh lỗi / R2 chưa cấu hình -> giữ link gốc.
 * Trả {product, warnings}. KHÔNG BAO GIỜ throw — lỗi thì giữ nguyên sản
 * phẩm + warning để luồng chính (ingest/extract-page) tiếp tục chạy.
 */
async function mirrorProductImages(store, imagesRuntime, product) {
  if (!product || !(product.images ?? []).length) return { product, warnings: [] };
  try {
    const { images, warnings } = await imagesRuntime.uploadImages(product.images);
    const changed = images.some((u, i) => u !== (product.images ?? [])[i]);
    if (!changed) return { product, warnings };
    const next = await updateStoredProduct(store, product.id, (current) => {
      // A newer crawl may have replaced the images while the upload was running.
      if (!current || JSON.stringify(current.images) !== JSON.stringify(product.images)) return null;
      return {
      ...current,
      originalImages: [...(product.images ?? [])],
      images,
      updated_at: nowIso(),
      version: (current.version ?? 1) + 1,
    };
    });
    return { product: next, warnings };
  } catch (e) {
    return {
      product,
      warnings: [`Không đưa được ảnh lên Cloudflare R2 (${e?.message ?? 'lỗi không rõ'}) — giữ link ảnh gốc.`],
    };
  }
}

function productSummary(p) {
  return {
    id: p.id,
    title: p.title,
    variants: p.variant_count ?? (p.variants ?? []).length,
    inStock: p.in_stock_count ?? (p.variants ?? []).filter((v) => v.in_stock).length,
    images: (p.images ?? []).length,
    currency: p.currency ?? 'USD',
    priceEstimated: Boolean(p.price_estimated),
    price: p.price ?? null,
  };
}

function parseBody(body, bodyText) {
  if (body !== undefined && body !== null) return body;
  if (bodyText == null || bodyText === '') return undefined;
  return JSON.parse(bodyText);
}

function splitPath(path) {
  const clean = String(path ?? '/').split('?')[0].split('#')[0];
  const trimmed = clean.replace(/\/+$/, '') || '/';
  return trimmed.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

// ---- main handler (pure: không fetch/Request) --------------------------------

export async function handleRequest(store, { method, path, headers, body, bodyText } = {}, opts = {}) {
  // Runtime AI: mặc định singleton dùng chung; test có thể truyền runtime
  // riêng (kèm fetch giả lập) qua opts.aiRuntime.
  const aiRuntime = opts.aiRuntime ?? defaultAiRuntime;
  // Runtime eBay Taxonomy: mặc định singleton dùng chung; test có thể
  // truyền runtime riêng (kèm fetch giả lập) qua opts.ebayRuntime.
  const ebayRuntime = opts.ebayRuntime ?? defaultEbayTaxonomyRuntime;
  // Runtime eBay Browse (v9.1): mặc định singleton dùng chung (chung khóa
  // Taxonomy); test có thể truyền runtime riêng (kèm fetch giả lập) qua
  // opts.browseRuntime.
  const browseRuntime = opts.browseRuntime ?? defaultEbayBrowseRuntime;
  // Runtime ảnh Cloudflare R2 (v9.1): mặc định singleton dùng chung; test
  // có thể truyền runtime riêng (kèm fetch giả lập) qua opts.imagesRuntime.
  const imagesRuntime = opts.imagesRuntime ?? defaultCloudflareImagesRuntime;
  try {
    const m = String(method ?? 'GET').toUpperCase();
    const parts = splitPath(path);
    if (bodyText != null && new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) return err(413, 'body_too_large');

    // The extension uses only /api/ingest/*, the Cloudflare Access bypass.
    // The existing /api/ai/extract-page route remains for authenticated web users.
    if (m === 'POST' && parts.join('/') === 'api/ingest/extract-page') {
      const record = await verifyApiKey(store, bearerToken(headers));
      if (!record) return err(401, 'invalid_api_key');
      parts[1] = 'ai';
    }

    // GET /api/ingest/ping
    if (m === 'GET' && parts.join('/') === 'api/ingest/ping') {
      const record = await verifyApiKey(store, bearerToken(headers));
      if (!record) return err(401, 'invalid_api_key');
      return ok(200, { ok: true, name: record.name });
    }

    // POST /api/ingest/records
    if (m === 'POST' && parts.join('/') === 'api/ingest/records') {
      const record = await verifyApiKey(store, bearerToken(headers));
      if (!record) return err(401, 'invalid_api_key');
      if (bodyText != null && new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
        return err(413, 'body_too_large');
      }
      let parsed;
      try {
        parsed = parseBody(body, bodyText);
      } catch {
        return err(400, 'invalid_records');
      }
      if (!parsed || parsed.records === undefined) return err(400, 'records_required');
      if (!Array.isArray(parsed.records)) return err(400, 'invalid_records');
      if (parsed.records.length > MAX_RECORDS_PER_REQUEST) return err(400, 'too_many_records');

      const existing = await store.listProducts();
      const existingById = new Map(existing.map((p) => [p.id, p]));
      const existingIds = new Set(existingById.keys());
      const { products, errors, stats } = Core.parseImport(parsed.records);
      if (products.length === 0 && errors.length > 0) {
        for (const e of errors) await store.pushCrawlError(e);
        return err(400, 'invalid_products', { errors });
      }
      for (const e of errors) await store.pushCrawlError(e);
      for (let i = 0; i < products.length; i++) {
        const incoming = products[i];
        products[i] = await updateStoredProduct(store, incoming.id, (current) => Core.mergeProducts(current, incoming));
      }
      // v9.1: đưa ảnh lên Cloudflare R2 (best-effort, tuần tự): ảnh upload
      // được thì product.images thành link Cloudflare, link gốc giữ trong
      // product.originalImages; R2 chưa cấu hình / ảnh lỗi thì giữ link gốc.
      const imageWarnings = [];
      for (let i = 0; i < products.length; i++) {
        const mirrored = await mirrorProductImages(store, imagesRuntime, products[i]);
        products[i] = mirrored.product;
        for (const w of mirrored.warnings) if (!imageWarnings.includes(w)) imageWarnings.push(w);
      }
      const updated = products.some((p) => existingIds.has(p.id));
      return ok(200, {
        ok: true,
        updated,
        products: products.map(productSummary),
        stats,
        errors,
        partial: errors.length > 0,
        ...(imageWarnings.length ? { imageWarnings } : {}),
      });
    }

    // GET /api/bootstrap
    if (m === 'GET' && parts.join('/') === 'api/bootstrap') {
      const [products, config, crawlErrors, keys] = await Promise.all([
        store.listProducts(),
        getConfig(store),
        store.listCrawlErrors(),
        store.listKeys(),
      ]);
      return ok(200, {
        ok: true,
        products,
        config,
        crawlErrors: crawlErrors.slice(-MAX_CRAWL_ERRORS_RESPONSE),
        keys: keys.map(publicKey),
      });
    }

    // GET /api/products
    if (m === 'GET' && parts.join('/') === 'api/products') {
      return ok(200, { ok: true, products: await store.listProducts() });
    }

    // GET /api/products/:id
    if (m === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'products') {
      const product = await store.getProduct(parts[2]);
      if (!product) return err(404, 'not_found');
      return ok(200, { ok: true, product });
    }

    // PUT /api/products/:id
    if (m === 'PUT' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'products') {
      const product = await store.getProduct(parts[2]);
      if (!product) return err(404, 'not_found');
      let patch;
      try {
        patch = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || (patch.edits !== undefined && (!patch.edits || typeof patch.edits !== 'object' || Array.isArray(patch.edits)))) {
        return err(400, 'invalid_records');
      }
      if (patch.version != null && Number(patch.version) !== Number(product.version)) {
        return err(409, 'version_conflict', { currentVersion: product.version });
      }
      const next = {
        ...product,
        edits: { ...(product.edits ?? {}), ...(patch.edits ?? {}) },
        updated_at: nowIso(),
        version: (product.version ?? 1) + 1,
      };
      if (patch.product_type !== undefined) next.product_type = patch.product_type;
      if (patch.category !== undefined) next.category = patch.category;
      // Số liệu eBay tham khảo (v9.1, tự động qua Browse API): tổng số đã
      // bán ƯỚC TÍNH của listing tương ứng (estimatedSoldQuantity) + số
      // người theo dõi (watchCount) + listing đã khớp (tiêu đề/link/điểm
      // khớp/nguồn). Chỉ là thông tin tham khảo cho seller, KHÔNG đưa vào
      // file CSV upload Seller Hub. Seller sửa tay mã item / số watchers
      // trong form chi tiết thì các trường này cũng nhận giá trị đó.
      if (patch.ebaySold !== undefined) {
        const n = Number(patch.ebaySold);
        next.ebaySold = patch.ebaySold == null ? null : (Number.isInteger(n) && n >= 0 ? n : product.ebaySold ?? null);
      }
      if (patch.ebayWatchers !== undefined) {
        const n = Number(String(patch.ebayWatchers).replace(/,/g, ''));
        next.ebayWatchers = patch.ebayWatchers == null || patch.ebayWatchers === '' ? null : (Number.isInteger(n) && n >= 0 ? n : product.ebayWatchers ?? null);
      }
      if (patch.ebayItemId !== undefined) next.ebayItemId = patch.ebayItemId == null ? null : String(patch.ebayItemId).trim() || null;
      if (patch.ebayWatchersSource !== undefined) next.ebayWatchersSource = patch.ebayWatchersSource == null ? null : String(patch.ebayWatchersSource).trim() || null;
      if (patch.ebayItemTitle !== undefined) next.ebayItemTitle = patch.ebayItemTitle == null ? null : String(patch.ebayItemTitle).trim() || null;
      if (patch.ebayItemUrl !== undefined) next.ebayItemUrl = patch.ebayItemUrl == null ? null : String(patch.ebayItemUrl).trim() || null;
      if (patch.ebayMatchScore !== undefined) {
        const s = Number(patch.ebayMatchScore);
        next.ebayMatchScore = patch.ebayMatchScore == null ? null : (Number.isFinite(s) && s >= 0 && s <= 1 ? s : product.ebayMatchScore ?? null);
      }
      if (patch.ebayMatchSource !== undefined) next.ebayMatchSource = patch.ebayMatchSource == null ? null : String(patch.ebayMatchSource).trim() || null;
      // Team đã chốt category trong edits thì category hiển thị theo edits.
      if (next.edits.category) next.category = next.edits.category;
      try { await store.putProduct(next, product.version ?? 1); }
      catch (error) {
        if (!(error instanceof VersionConflict)) throw error;
        return err(409, 'version_conflict', { currentVersion: (await store.getProduct(product.id))?.version });
      }
      return ok(200, { ok: true, product: next });
    }

    // GET /api/config
    if (m === 'GET' && parts.join('/') === 'api/config') {
      return ok(200, { ok: true, config: await getConfig(store) });
    }

    // PUT /api/config
    if (m === 'PUT' && parts.join('/') === 'api/config') {
      let patch;
      try {
        patch = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err(400, 'invalid_records');
      try { return ok(200, { ok: true, config: await putConfig(store, patch) }); }
      catch (error) {
        if (error.message?.startsWith('invalid_config:')) return err(400, 'invalid_config', { field: error.message.slice(15) });
        throw error;
      }
    }

    // GET /api/crawl-errors
    if (m === 'GET' && parts.join('/') === 'api/crawl-errors') {
      const errors = await store.listCrawlErrors();
      return ok(200, { ok: true, crawlErrors: errors.slice(-MAX_CRAWL_ERRORS_RESPONSE) });
    }

    // POST /api/keys
    if (m === 'POST' && parts.join('/') === 'api/keys') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      try {
        const created = await createApiKey(store, payload.name);
        return ok(201, { ok: true, ...created });
      } catch (e) {
        if (e?.code === 'name_required') return err(400, 'name_required');
        throw e;
      }
    }

    // GET /api/keys
    if (m === 'GET' && parts.join('/') === 'api/keys') {
      const keys = await store.listKeys();
      return ok(200, { ok: true, keys: keys.map(publicKey) });
    }

    // DELETE /api/keys/:id
    if (m === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'keys') {
      const deleted = await store.deleteKey(parts[2]);
      if (!deleted) return err(404, 'not_found');
      return ok(200, { ok: true, deleted: true });
    }

    // POST /api/reset — guard chống ghi đè dữ liệu thật
    if (m === 'POST' && parts.join('/') === 'api/reset') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      if (payload.confirm !== true) return err(400, 'confirm_required');
      const products = await store.listProducts();
      if (products.length > 0) return err(409, 'has_real_data');
      await store.clearData();
      return ok(200, { ok: true, reset: true });
    }

    // POST /api/ai/suggest — có key AI thì gọi LLM thật, không có key thì
    // gợi ý theo luật. Trả thêm cờ provider ('openai' | 'gemini' |
    // 'rule-based') để giao diện hiển thị rõ nguồn gợi ý.
    if (m === 'POST' && parts.join('/') === 'api/ai/suggest') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      let product = payload.product ?? null;
      if (!product && payload.productId) {
        product = await store.getProduct(payload.productId);
        if (!product) return err(404, 'not_found');
      }
      if (!product || typeof product !== 'object') return err(400, 'product_required');
      const result = await suggestWithRuntime(product, aiRuntime);
      return ok(200, { ok: true, ...result });
    }

    // POST /api/ai/group — AI gom nhóm các sản phẩm GIỐNG NHAU / cùng loại
    // để mỗi nhóm xuất 1 file CSV riêng. Body: { products?: [...] } (gửi
    // trực tiếp, vd từ extension/luồng Sheet) hoặc { productIds?: [...] }
    // (lấy từ store). Có key AI thì gọi LLM thật theo batch 20 sản phẩm,
    // gặp 429 thì dừng gọi LLM và dùng nhóm theo từ khoá cho phần còn lại
    // (giữ kết quả đã gom xong, cờ stopped429 để giao diện báo đợi 1 phút).
    // Không có key thì nhóm theo từ khoá, cờ provider: 'rule-based'.
    // Trả { assignments: [{productId, groupKey, groupLabel, ebayType}],
    // groups: [{key, label, categoryId, productIds, sampleTitles, count}],
    // unclassified, warnings, provider, stopped429 }. KHÔNG tự lưu edits —
    // client lưu qua PUT /api/products/:id sau khi team xem bảng tóm tắt.
    if (m === 'POST' && parts.join('/') === 'api/ai/group') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      let products = null;
      if (Array.isArray(payload.products)) products = payload.products;
      else if (Array.isArray(payload.productIds)) {
        // Chặn trước vòng lặp: 500k id vẫn lọt 6MB body và sẽ gây 500k lần đọc store.
        if (payload.productIds.length > MAX_RECORDS_PER_REQUEST) return err(400, 'too_many_products', { max: MAX_RECORDS_PER_REQUEST });
        products = [];
        const missing = [];
        for (const id of payload.productIds) {
          const p = await store.getProduct(id);
          if (p) products.push(p);
          else missing.push(id);
        }
        if (missing.length) {
          return err(404, 'not_found', { missingIds: missing.slice(0, 20), missingCount: missing.length });
        }
      }
      if (!products || !products.length) return err(400, 'products_required');
      if (products.length > MAX_RECORDS_PER_REQUEST) return err(400, 'too_many_products', { max: MAX_RECORDS_PER_REQUEST });
      if (products.some((p) => !p || typeof p !== 'object' || p.id == null)) {
        return err(400, 'invalid_products', { reason: 'mỗi sản phẩm cần có id' });
      }
      const result = await groupWithRuntime(products, aiRuntime);
      return ok(200, { ok: true, totalProducts: products.length, ...result });
    }

    // POST /api/ai/draft-categories — AI gợi ý tên danh mục eBay cho các
    // nhóm CHƯA có template (để hiển thị trong file nháp, KHÔNG ghi vào
    // cột Category của CSV). Body: { groups: [{key, label, count?,
    // sampleTitles?}] }. Nhóm gối (đã có template) và nhóm chưa phân loại
    // được bỏ qua phía server. Không có key AI thì trả gợi ý rỗng kèm
    // warning, KHÔNG lỗi — file nháp vẫn tạo được. Trả { suggestions:
    // [{groupKey, suggestedCategory, suggestedAspects, note}], warnings,
    // provider }. Gợi ý là phỏng đoán CHƯA XÁC MINH — team phải kiểm chứng
    // tên danh mục ở Seller Hub trước khi dùng.
    if (m === 'POST' && parts.join('/') === 'api/ai/draft-categories') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      const groups = payload.groups;
      if (!Array.isArray(groups) || !groups.length) return err(400, 'groups_required');
      if (groups.length > 50) return err(400, 'too_many_groups', { max: 50 });
      if (groups.some((g) => !g || typeof g !== 'object' || !(g.key ?? g.groupKey))) {
        return err(400, 'invalid_groups', { reason: 'mỗi nhóm cần có key' });
      }
      const result = await suggestDraftCategoriesWithRuntime(groups, aiRuntime);
      return ok(200, { ok: true, ...result });
    }

    // POST /api/ai/extract-page — trích xuất 1 trang sản phẩm bằng AI (v9).
    // Body 1 trang: {url, sourceSite?, sourceProductId?, raw: {title?,
    // price?, currency?, brand?, images?, description?, specs?, attributes?,
    // variants?, pageText?}} — raw là dữ liệu extension đã đọc từ trang
    // (JSON-LD + biến thể + text hiển thị ≤12.000 ký tự). Hoặc body hàng
    // loạt: {pages: [raw, ...]} tối đa 20 trang, gặp 429 thì dừng gọi LLM
    // (các trang còn lại dùng trích xuất theo luật, cờ stopped429).
    // Có key AI thì gọi LLM thật (giãn ≥4s/lần như v5); không có key thì
    // trích xuất theo luật từ dữ liệu trang + warning. Kết quả AI được
    // kiểm chứng (size/màu từ trang gốc, thiếu thì null + warning, KHÔNG
    // bịa) rồi lưu thành sản phẩm (gộp như ingest: giữ edits của team).
    // Trả 1 trang: {product, extracted, warnings, provider, rateLimited};
    // hàng loạt: {results: [{product, extracted, warnings, provider,
    // rateLimited}], stopped429, provider}.
    if (m === 'POST' && parts.join('/') === 'api/ai/extract-page') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      const saveExtracted = async (raw, result) => {
        const record = extractPageRecord(raw, result.extracted);
        if (!record.source_product_id) record.source_product_id = Core.sourceProductIdFromUrl(record.source_url);
        if (!record.source_site && record.source_url) {
          try { record.source_site = new URL(record.source_url).hostname; } catch { /* giữ null -> normalizeRecord báo lỗi */ }
        }
        const { products, errors } = Core.parseImport([record]);
        if (!products.length) return { product: null, errors };
        for (let i = 0; i < products.length; i++) {
          const incoming = products[i];
          products[i] = await updateStoredProduct(store, incoming.id, (current) => Core.mergeProducts(current, incoming));
        }
        return { product: products[0], errors };
      };
      // Hàng loạt: {pages: [...]}.
      if (Array.isArray(payload.pages)) {
        if (!payload.pages.length) return err(400, 'pages_required');
        if (payload.pages.length > 20) return err(400, 'too_many_pages', { max: 20 });
        const { results, stopped429, provider } = await extractPagesWithRuntime(payload.pages, aiRuntime);
        const out = [];
        let enrichStopped429 = false;
        const imageWarnings = [];
        for (let i = 0; i < payload.pages.length; i++) {
          const saved = await saveExtracted(payload.pages[i], results[i]);
          // v9.1: tự động tìm listing eBay khớp ngay sau khi lưu sản phẩm
          // mới — không cần seller dán link hay dán số. Gặp 429 thì dừng
          // enrich các trang còn lại (sản phẩm vẫn lưu bình thường).
          let enrichment = null;
          let product = saved.product;
          if (product && !enrichStopped429) {
            const enriched = await enrichSavedProduct(store, browseRuntime, product);
            enrichment = enriched.enrichment;
            product = enriched.product;
            if (enrichment?.stopped429) enrichStopped429 = true;
          } else if (product && enrichStopped429) {
            enrichment = { matched: false, source: 'browse-api', stopped429: true, warning: 'Đã dừng tìm listing eBay do chạm giới hạn (429) — đợi 1 phút rồi bấm "Tìm listing eBay cho tất cả sản phẩm chưa có số liệu" trong tab Duyệt.' };
          }
          // v9.1: đưa ảnh lên Cloudflare R2 (best-effort).
          const pageImageWarnings = [];
          if (product) {
            const mirrored = await mirrorProductImages(store, imagesRuntime, product);
            product = mirrored.product;
            for (const w of mirrored.warnings) {
              pageImageWarnings.push(w);
              if (!imageWarnings.includes(w)) imageWarnings.push(w);
            }
          }
          out.push({ product, errors: saved.errors, enrichment, imageWarnings: pageImageWarnings, ...results[i], warnings: [...(results[i].warnings ?? []), ...pageImageWarnings] });
        }
        return ok(200, { ok: true, results: out, stopped429, provider, enrichStopped429, ...(imageWarnings.length ? { imageWarnings } : {}) });
      }
      const url = String(payload.url ?? payload.raw?.url ?? payload.raw?.source_url ?? '').trim();
      if (!url) return err(400, 'url_required');
      const raw = {
        ...(payload.raw ?? {}),
        url,
        sourceSite: payload.sourceSite ?? payload.raw?.sourceSite ?? payload.raw?.source_site ?? null,
        sourceProductId: payload.sourceProductId ?? payload.raw?.sourceProductId ?? payload.raw?.source_product_id ?? null,
      };
      const result = await extractPageWithRuntime(raw, aiRuntime);
      const saved = await saveExtracted(raw, result);
      if (!saved.product) return err(400, 'invalid_products', { errors: saved.errors });
      // v9.1: tự động tìm listing eBay khớp ngay sau khi lưu sản phẩm mới.
      const enriched = await enrichSavedProduct(store, browseRuntime, saved.product);
      // v9.1: đưa ảnh lên Cloudflare R2 (best-effort).
      const mirrored = await mirrorProductImages(store, imagesRuntime, enriched.product);
      return ok(200, { ok: true, product: mirrored.product, extracted: result.extracted, warnings: [...result.warnings, ...mirrored.warnings], provider: result.provider, rateLimited: result.rateLimited, enrichment: enriched.enrichment });
    }

    // GET /api/ai/status — chỉ trả {configured, provider, model, source},
    // KHÔNG BAO GIỜ trả key.
    if (m === 'GET' && parts.join('/') === 'api/ai/status') {
      return ok(200, { ok: true, ...aiRuntime.getStatus() });
    }

    // POST /api/ai/config — lưu key AI dán trong web vào RAM server
    // (mất khi restart; key env AI_API_KEY nếu có sẽ được ưu tiên hơn).
    // Body: {provider?, model?, baseUrl?, apiKey?}. Trả status, không trả key.
    if (m === 'POST' && parts.join('/') === 'api/ai/config') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return err(400, 'invalid_records');
      try {
        const status = aiRuntime.setMemoryConfig(payload);
        return ok(200, { ok: true, ...status });
      } catch (e) {
        if (e?.code === 'invalid_provider') return err(400, 'invalid_provider', { provider: e.provider });
        if (e?.code === 'invalid_base_url') return err(400, 'invalid_base_url');
        throw e;
      }
    }

    // DELETE /api/ai/config — xoá key/cấu hình đã dán trong web khỏi RAM.
    // (Key trong env AI_API_KEY nếu có thì vẫn còn — xem GET /api/ai/status.)
    if (m === 'DELETE' && parts.join('/') === 'api/ai/config') {
      return ok(200, { ok: true, ...aiRuntime.clearMemoryConfig() });
    }

    // ---- eBay Taxonomy (v8): tra mã danh mục thật từ eBay ---------------
    // Mã dùng để xuất file CSV upload được CHỈ lấy từ Taxonomy API của
    // eBay (verifiedFromEbay) hoặc từ template thật user nạp vào. Mã do AI
    // đoán (draftCategorySuggestion) là phỏng đoán chưa xác minh, KHÔNG
    // BAO GIỜ ghi vào cột Category. Khóa eBay (App ID + Cert ID) chỉ ở
    // server, không trả ra ngoài, không ghi log.

    // GET /api/ebay/status — chỉ trả {configured, marketplace, environment,
    // source}, KHÔNG BAO GIỜ trả key.
    if (m === 'GET' && parts.join('/') === 'api/ebay/status') {
      return ok(200, { ok: true, ...ebayRuntime.getStatus() });
    }

    // POST /api/ebay/config — lưu khóa eBay dán trong web vào RAM server
    // (mất khi restart; khóa env EBAY_APP_ID/EBAY_CERT_ID nếu có sẽ được
    // ưu tiên hơn). Body: {appId?, certId?, environment?, marketplaceId?}.
    // Trả status, không trả key.
    if (m === 'POST' && parts.join('/') === 'api/ebay/config') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return err(400, 'invalid_records');
      try {
        const status = ebayRuntime.setMemoryConfig(payload);
        return ok(200, { ok: true, ...status });
      } catch (e) {
        if (e?.code === 'invalid_environment') return err(400, 'invalid_environment', { environment: e.environment });
        throw e;
      }
    }

    // DELETE /api/ebay/config — xoá khóa/cấu hình đã dán trong web khỏi RAM.
    // (Khóa trong env EBAY_APP_ID/EBAY_CERT_ID nếu có thì vẫn còn.)
    if (m === 'DELETE' && parts.join('/') === 'api/ebay/config') {
      return ok(200, { ok: true, ...ebayRuntime.clearMemoryConfig() });
    }

    // GET /api/ebay/check — kiểm tra kết nối eBay bằng cách gọi thử
    // getDefaultCategoryTreeId (không cần khóa crawl, chỉ cần khóa eBay).
    if (m === 'GET' && parts.join('/') === 'api/ebay/check') {
      try {
        const categoryTreeId = await ebayRuntime.getDefaultCategoryTreeId();
        const status = ebayRuntime.getStatus();
        return ok(200, { ok: true, connected: true, categoryTreeId, marketplace: status.marketplace, environment: status.environment });
      } catch (e) {
        return ebayErrorResponse(e);
      }
    }

    // Verify a known Category ID and return its actual item-specific schema.
    if (m === 'GET' && parts.length === 4 && parts.slice(0, 3).join('/') === 'api/ebay/categories') {
      try { return ok(200, { ok: true, category: await ebayRuntime.getCategoryDetails(parts[3]) }); }
      catch (error) { return ebayErrorResponse(error); }
    }

    // GET /api/ebay/category-suggestions?q=<từ khoá> — tra tay 1 mã danh
    // mục. Chỉ trả category là LEAF (eBay chỉ nhận leaf), tối đa 10 gợi ý.
    if (m === 'GET' && parts.join('/') === 'api/ebay/category-suggestions') {
      let q = '';
      try {
        q = new URL(path, 'http://localhost').searchParams.get('q') ?? '';
      } catch {
        q = '';
      }
      if (!q.trim()) return err(400, 'query_required');
      try {
        const suggestions = await ebayRuntime.getCategorySuggestions(q.trim());
        return ok(200, { ok: true, query: q.trim(), suggestions, warnings: suggestions.length ? [] : ['eBay không gợi ý được danh mục nào cho từ khoá này — thử từ khoá khác (vd tên loại sản phẩm bằng tiếng Anh).'] });
      } catch (e) {
        return ebayErrorResponse(e);
      }
    }

    // POST /api/ebay/resolve-groups — tra mã danh mục cho nhiều nhóm cùng
    // lúc. Body: { groups: [{groupKey|key, label, sampleTitles?, count?}] }
    // (tối đa 50 nhóm). Trả { results: [{groupKey, categoryId,
    // categoryName, categoryPath, verifiedFromEbay, requiredAspects,
    // recommendedAspects, warning}], warnings, provider: 'ebay-taxonomy' }.
    // Nhóm nào không tra được mã thì categoryId=null + warning, giữ nguyên
    // file nháp như v7, KHÔNG bịa mã. KHÔNG tự lưu edits — client lưu qua
    // PUT /api/products/:id sau khi team bấm chấp nhận từng mã.
    if (m === 'POST' && parts.join('/') === 'api/ebay/resolve-groups') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      const groups = payload.groups;
      if (!Array.isArray(groups) || !groups.length) return err(400, 'groups_required');
      if (groups.length > EBAY_RESOLVE_MAX_GROUPS) return err(400, 'too_many_groups', { max: EBAY_RESOLVE_MAX_GROUPS });
      if (groups.some((g) => !g || typeof g !== 'object' || !(g.groupKey ?? g.key))) {
        return err(400, 'invalid_groups', { reason: 'mỗi nhóm cần có groupKey' });
      }
      try {
        const result = await ebayRuntime.resolveGroups(groups);
        return ok(200, { ok: true, provider: 'ebay-taxonomy', ...result });
      } catch (e) {
        return ebayErrorResponse(e);
      }
    }

    // POST /api/ebay/enrich — tìm listing eBay khớp cho 1 sản phẩm (v9.1).
    // Body: {productId, ebayItemId?} (ebayItemId: mã số/mã REST do seller
    // sửa tay khi khớp tự động sai — bỏ qua bước search, lấy thẳng listing
    // đó). Trả {product, enrichment}. Chưa có khóa eBay -> 400
    // ebay_not_configured; khóa sai -> 502 ebay_auth_failed; không khớp
    // thì enrichment.matched=false + warning, KHÔNG gán bừa, vẫn 200.
    if (m === 'POST' && parts.join('/') === 'api/ebay/enrich') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      const productId = String(payload.productId ?? '').trim();
      if (!productId) return err(400, 'product_required');
      const product = await store.getProduct(productId);
      if (!product) return err(404, 'not_found');
      const forceItemId = payload.ebayItemId != null ? String(payload.ebayItemId).trim() : null;
      // fresh: seller bấm "Tìm lại"/sửa tay -> tra lại eBay, không dùng cache.
      const enrichment = await browseRuntime.enrichProduct(product, { forceItemId: forceItemId || undefined, fresh: true });
      if (enrichment.code === 'ebay_not_configured') return err(400, 'ebay_not_configured', { message: enrichment.warning });
      if (enrichment.code === 'ebay_auth_failed') return err(502, 'ebay_auth_failed', { message: enrichment.warning });
      let saved = product;
      if (enrichment.matched) saved = await applyBrowseEnrichment(store, product, enrichment);
      return ok(200, { ok: true, product: saved, enrichment });
    }

    // POST /api/ebay/enrich-all — tìm listing eBay khớp cho nhiều sản phẩm
    // chưa có số liệu (v9.1). Body: {productIds?} — không gửi thì lấy tất
    // cả sản phẩm chưa có ebayItemId (tối đa 200). Chạy tuần tự, giãn
    // 200ms/sản phẩm; gặp 429 thì dừng, trả stopped429=true + kết quả đã
    // làm xong. Trả {results: [{productId, matched, itemId, warning}],
    // stopped429}.
    if (m === 'POST' && parts.join('/') === 'api/ebay/enrich-all') {
      let payload;
      try {
        payload = parseBody(body, bodyText) ?? {};
      } catch {
        return err(400, 'invalid_records');
      }
      let products;
      if (Array.isArray(payload.productIds)) {
        if (payload.productIds.length > MAX_RECORDS_PER_REQUEST) return err(400, 'too_many_products', { max: MAX_RECORDS_PER_REQUEST });
        products = [];
        for (const id of payload.productIds) {
          const p = await store.getProduct(String(id));
          if (p) products.push(p);
        }
      } else {
        products = (await store.listProducts()).filter((p) => !(p.ebayItemId ?? p.ebayItemUrl));
      }
      if (!products.length) return ok(200, { ok: true, results: [], stopped429: false });
      if (products.length > MAX_RECORDS_PER_REQUEST) return err(400, 'too_many_products', { max: MAX_RECORDS_PER_REQUEST });
      const results = [];
      let stopped429 = false;
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const enrichment = await browseRuntime.enrichProduct(p);
        if (enrichment.code === 'ebay_not_configured') return err(400, 'ebay_not_configured', { message: enrichment.warning });
        if (enrichment.code === 'ebay_auth_failed') return err(502, 'ebay_auth_failed', { message: enrichment.warning });
        if (enrichment.matched) await applyBrowseEnrichment(store, p, enrichment);
        results.push({
          productId: p.id,
          matched: Boolean(enrichment.matched),
          itemId: enrichment.matched ? (enrichment.legacyItemId ?? enrichment.itemId ?? null) : null,
          warning: enrichment.warning ?? null,
        });
        if (enrichment.stopped429) {
          stopped429 = true;
          break;
        }
        if (i < products.length - 1) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return ok(200, { ok: true, results, stopped429 });
    }

    return err(404, 'not_found');
  } catch (e) {
    if (e instanceof VersionConflict) return err(409, 'version_conflict');
    // Không lộ chi tiết lỗi nội bộ ra ngoài; popup chỉ cần mã server_error.
    console.error('[api] handleRequest error:', e);
    return err(500, 'server_error');
  }
}

// ---- Cloudflare Workers entrypoint -------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
    }
    let bodyText = '';
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
      bodyText = await req.text();
    }
    const plainHeaders = {};
    req.headers.forEach((v, k) => { plainHeaders[k] = v; });
    // Env Workers (AI_API_KEY / AI_PROVIDER / AI_MODEL / AI_BASE_URL đặt
    // bằng `wrangler pages secret put` hoặc vars) đưa vào runtime AI.
    applyEnvToRuntime(defaultAiRuntime, env ?? {});
    // Env Workers cho eBay Taxonomy (EBAY_APP_ID / EBAY_CERT_ID đặt bằng
    // `wrangler pages secret put`, EBAY_ENVIRONMENT / EBAY_MARKETPLACE_ID
    // bằng vars) đưa vào runtime eBay.
    applyEnvToEbayRuntime(defaultEbayTaxonomyRuntime, env ?? {});
    // Env Workers cho ảnh Cloudflare R2 (CLOUDFLARE_R2_* đặt bằng
    // `wrangler pages secret put`) đưa vào runtime ảnh.
    applyEnvToImagesRuntime(defaultCloudflareImagesRuntime, env ?? {});
    let store;
    try {
      store = new D1Store(env);
    } catch (e) {
      // Thiếu binding D1 (wrangler.toml) — trả JSON thay vì 500 rỗng.
      console.error('[api] D1Store init error:', e);
      return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers });
    }
    const { status, json } = await handleRequest(store, {
      method: req.method,
      // Giữ cả query string trong path để endpoint tra tay
      // (/api/ebay/category-suggestions?q=...) đọc được từ khoá — splitPath
      // trong handleRequest tự bỏ phần query khi định tuyến.
      path: url.pathname + url.search,
      headers: plainHeaders,
      bodyText,
    });
    return new Response(JSON.stringify(json), { status, headers });
  },
};
