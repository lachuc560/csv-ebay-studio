// scripts/local-store.mjs — Lưu bền dữ liệu dev local xuống file trên máy.
// Vấn đề v5: dev server dùng MemoryStore thuần — tắt cửa sổ Terminal là mất
// hết sản phẩm đã crawl, cấu hình giá, lỗi crawl VÀ khóa crawl (khóa chỉ còn
// là hash trong RAM nên sau restart extension báo invalid_api_key, phải tạo
// khóa mới + crawl lại từ đầu). LocalFileStore bọc MemoryStore: mọi thay đổi
// được ghi ngay xuống data/local-data.json (ghi tmp rồi đổi tên, tránh file
// dở dang nếu đang ghi mà tắt máy), mở lại server là tự tải lại.
// CHỈ dùng cho dev server local — bản deploy Cloudflare vẫn dùng D1Store.
// KHÔNG lưu key AI ở đây: key AI vẫn chỉ ở RAM server (theo đúng v5), tắt
// server là mất, phải dán lại. File này chỉ chứa sản phẩm, config, lỗi crawl
// và HASH của khóa crawl (không bao giờ chứa khóa gốc), nên an toàn để file
// nằm trên máy user; vẫn thêm data/ vào .gitignore để không commit nhầm.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../server/api.mjs';

export const SNAPSHOT_VERSION = 1;

/** Đường dẫn mặc định: <repo>/data/local-data.json.
 *  Đổi bằng biến môi trường CSV_STUDIO_DATA_FILE (dùng cho test). */
export function defaultDataFilePath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'local-data.json');
}

export function resolveDataFilePath(env = process.env) {
  const custom = env?.CSV_STUDIO_DATA_FILE;
  return custom ? path.resolve(custom) : defaultDataFilePath();
}

export function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, savedAt: null, products: [], meta: {}, apiKeys: [], crawlErrors: [] };
}

/** Đọc snapshot từ file. File chưa có -> snapshot rỗng. File hỏng (JSON lỗi
 *  hoặc sai dạng) -> dời file hỏng sang <path>.corrupt-<timestamp> để không
 *  mất hẳn, rồi trả snapshot rỗng. Không bao giờ ném lỗi ra ngoài. */
export function loadSnapshot(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { snapshot: emptySnapshot(), corrupt: false, existed: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.products)) {
      throw new Error('bad snapshot shape');
    }
    return {
      snapshot: {
        version: SNAPSHOT_VERSION,
        savedAt: parsed.savedAt ?? null,
        products: parsed.products,
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
        apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
        crawlErrors: Array.isArray(parsed.crawlErrors) ? parsed.crawlErrors : [],
      },
      corrupt: false,
      existed: true,
    };
  } catch {
    const backup = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { renameSync(filePath, backup); } catch { /* giữ nguyên file hỏng */ }
    return { snapshot: emptySnapshot(), corrupt: true, existed: true, backup };
  }
}

/** Ghi snapshot của store xuống file (ghi file tmp cùng thư mục rồi rename
 *  để file đích không bao giờ ở trạng thái dở dang). */
export function saveSnapshot(store, filePath) {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    products: store.listProducts(),
    meta: Object.fromEntries(store.meta.entries()),
    apiKeys: store.listKeys(),
    crawlErrors: store.listCrawlErrors(),
  };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
  renameWithRetry(tmp, filePath);
  return snapshot;
}

/** Windows: antivirus/indexer giữ file đích trong tích tắc làm renameSync
 *  lỗi EPERM/EBUSY/EACCES — thử lại vài lần thay vì bỏ lưu im lặng. */
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      const until = Date.now() + 20 * i;
      while (Date.now() < until) { /* chờ ngắn, đồng bộ */ }
    }
  }
}

/** MemoryStore có lưu file. Nạp snapshot lúc khởi tạo; mỗi lần đổi dữ liệu
 *  (thêm/sửa sản phẩm, đổi config, tạo/xoá khóa, ghi lỗi crawl, xoá dữ liệu)
 *  thì ghi file. Lỗi ghi file chỉ log, không làm sập server.
 *  Riêng verifyApiKeyRecord (ping kiểm tra khóa) chỉ đổi last_used_at trong
 *  RAM nên KHÔNG ghi file — tránh ghi đĩa mỗi lần extension ping.
 *
 *  debounceMs (mặc định 0 = ghi ngay, dùng trong test): > 0 thì gom nhiều
 *  thay đổi liên tiếp thành 1 lần ghi (ingest 200 record trước đây ghi lại
 *  TOÀN BỘ file ~400 lần, chặn event loop). Dev server dùng 250ms và gọi
 *  flush() khi tắt (Ctrl+C / exit) để không mất thay đổi cuối. */
export class LocalFileStore extends MemoryStore {
  constructor(filePath = resolveDataFilePath(), { debounceMs = 0 } = {}) {
    super();
    this.dataFile = filePath;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.dirty = false;
    this.flushTimer = null;
    const { snapshot, corrupt, backup } = loadSnapshot(filePath);
    for (const p of snapshot.products) {
      if (p && typeof p === 'object' && p.id) this.products.set(p.id, p);
    }
    for (const [k, v] of Object.entries(snapshot.meta)) this.meta.set(k, String(v));
    for (const k of snapshot.apiKeys) {
      if (k && typeof k === 'object' && k.id) this.apiKeys.set(k.id, { ...k });
    }
    this.crawlErrors = [...snapshot.crawlErrors];
    this.loadedAt = snapshot.savedAt;
    this.loadedCorruptBackup = corrupt ? (backup ?? null) : null;
    if (corrupt) console.error(`[local-store] file dữ liệu hỏng, đã dời sang ${backup ?? '(không dời được)'} và bắt đầu kho trống.`);
  }

  persist() {
    this.dirty = true;
    if (!this.debounceMs) return this.flush();
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.debounceMs);
      // Không giữ process sống chỉ vì timer ghi file; exit/SIGINT gọi flush().
      this.flushTimer.unref?.();
    }
    return this;
  }

  /** Ghi ngay nếu còn thay đổi chưa lưu (đồng bộ — an toàn trong 'exit'). */
  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty) return this;
    this.dirty = false;
    try {
      saveSnapshot(this, this.dataFile);
    } catch (e) {
      this.dirty = true;
      console.error(`[local-store] không ghi được ${this.dataFile}:`, e?.message ?? e);
    }
    return this;
  }

  putProduct(product, expectedVersion) { const out = super.putProduct(product, expectedVersion); this.persist(); return out; }
  putMeta(key, value) { super.putMeta(key, value); this.persist(); return value; }
  createApiKeyRecord(record) { const out = super.createApiKeyRecord(record); this.persist(); return out; }
  deleteKey(id) { const out = super.deleteKey(id); this.persist(); return out; }
  pushCrawlError(error) { const out = super.pushCrawlError(error); this.persist(); return out; }
  clearData() { super.clearData(); this.persist(); }

  /** Xoá hẳn file dữ liệu trên đĩa (dùng khi user muốn làm sạch máy). */
  deleteDataFile() {
    try { rmSync(this.dataFile, { force: true }); } catch { /* bỏ qua */ }
  }
}
