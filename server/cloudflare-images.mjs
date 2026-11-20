// server/cloudflare-images.mjs — Ảnh sản phẩm lên Cloudflare R2 (v9.1).
// Link ảnh trong CSV phải là link Cloudflare, không dùng link ảnh gốc của
// trang bán lẻ nữa: module này tải ảnh từ URL gốc (vd assets.sohohome.com)
// rồi upload lên bucket R2 qua S3-compatible API, trả về URL công khai
// trên Cloudflare (vd https://images.tencongty.com/images/ab/<hash>.jpg).
//
// Cấu hình qua env (KHÔNG hardcode, KHÔNG commit key thật):
//   CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID,
//   CLOUDFLARE_R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_BUCKET,
//   CLOUDFLARE_R2_PUBLIC_URL (vd https://images.tencongty.com hoặc
//   https://pub-xxx.r2.dev).
// Dev local: điền vào .env (xem .env.example). Deploy Cloudflare: đặt
// bằng `wrangler pages secret put` (xem wrangler.toml + README.md).
// KHÔNG có r2_buckets binding trong code — S3 API chạy được cả dev local
// lẫn Pages, chỉ cần env secrets.
//
// Key ảnh trong bucket lấy theo hash SHA-256 của URL gốc:
// `images/<2 ký tự đầu hash>/<hash đầy đủ>.<ext>` — cùng URL gốc thì
// cùng key nên crawl lại không upload trùng (cache trong RAM theo URL
// gốc; upload lại sau khi restart server cũng ghi đè đúng key đó với
// cùng nội dung).
//
// Ký SigV4 (AWS Signature Version 4) bằng WebCrypto thuần (crypto.subtle,
// có sẵn ở Node 20+ và Workers) — KHÔNG dependency ngoài. Region R2 là
// 'auto', service 's3'. Upload dùng PUT có x-amz-content-sha256 = hash
// thật của body.
//
// Nếu R2 chưa cấu hình thì GIỮ NGUYÊN link ảnh gốc + warning rõ trong
// kết quả (không lỗi, không chặn luồng). Lỗi 1 ảnh (tải lỗi / upload lỗi)
// thì ảnh đó giữ link gốc + warning, các ảnh khác vẫn lên Cloudflare.
// Timeout 20s/ảnh cho cả tải và upload. Ảnh tối đa 20MB.
//
// PicURL trong file CSV upload Seller Hub dùng product.images — sau khi
// upload thành công, product.images là link Cloudflare; link gốc giữ
// trong product.originalImages để đối chiếu (xem server/api.mjs).

export const R2_IMAGE_TIMEOUT_MS = 20_000;
export const R2_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const R2_CACHE_MAX_ENTRIES = 500;

/** Lỗi R2: mang code để endpoint trả warning rõ (không lộ key/secret). */
export class CloudflareImagesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudflareImagesError';
    this.code = code;
  }
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data; // Uint8Array
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toBytes(data));
  return bytesToHex(digest);
}

async function hmacSha256(key, data) {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', toBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, toBytes(data)));
}

/** Ngày giờ theo định dạng SigV4: {amzDate: 20261116T123456Z, dateStamp: 20261116}. */
function amzDates(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const mo = p(now.getUTCMonth() + 1);
  const d = p(now.getUTCDate());
  return {
    amzDate: `${y}${mo}${d}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`,
    dateStamp: `${y}${mo}${d}`,
  };
}

/** Fetch có timeout 20s: đua fetch với promise timeout (như ebay-taxonomy). */
async function fetchWithTimeout(url, init, fetchFn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CloudflareImagesError('r2_timeout', `Tải/upload ảnh timeout sau ${Math.round(timeoutMs / 1000)}s (${url})`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (e) {
    if (e instanceof CloudflareImagesError) throw e;
    if (e?.name === 'AbortError' || controller.signal.aborted) {
      throw new CloudflareImagesError('r2_timeout', `Tải/upload ảnh timeout sau ${Math.round(timeoutMs / 1000)}s (${url})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cachePut(map, key, value) {
  if (map.size >= R2_CACHE_MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

/** Lấy env R2 từ một object env (process.env ở dev, env Workers khi deploy).
 *  Key CHỈ kiểm tra không rỗng — không kiểm tra định dạng. */
export function pickR2Env(env) {
  const e = env ?? {};
  const str = (k) => (typeof e[k] === 'string' && e[k].trim() ? e[k].trim() : null);
  return {
    accountId: str('CLOUDFLARE_R2_ACCOUNT_ID'),
    accessKeyId: str('CLOUDFLARE_R2_ACCESS_KEY_ID'),
    secretAccessKey: str('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    bucket: str('CLOUDFLARE_R2_BUCKET'),
    publicUrl: str('CLOUDFLARE_R2_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
  };
}

export class CloudflareImagesRuntime {
  constructor(env = {}, fetchFn = globalThis.fetch) {
    this.env = pickR2Env(env);
    this.fetchFn = fetchFn;
    // Cache URL gốc -> URL Cloudflare (RAM, tối đa 500) để crawl lại
    // cùng ảnh không gọi upload lần nữa trong cùng phiên server.
    this.urlCache = new Map();
  }

  /** Đưa env mới vào runtime (dev-server lúc khởi động / Workers mỗi request). */
  applyEnv(env) {
    const next = pickR2Env(env);
    this.env = {
      accountId: next.accountId ?? this.env.accountId,
      accessKeyId: next.accessKeyId ?? this.env.accessKeyId,
      secretAccessKey: next.secretAccessKey ?? this.env.secretAccessKey,
      bucket: next.bucket ?? this.env.bucket,
      publicUrl: next.publicUrl ?? this.env.publicUrl,
    };
    return this.getStatus();
  }

  /** Cấu hình hiệu lực. */
  getEffectiveConfig() {
    return {
      ...this.env,
      source: (this.env.accountId && this.env.accessKeyId && this.env.secretAccessKey && this.env.bucket && this.env.publicUrl) ? 'env' : 'none',
    };
  }

  /** Đủ 5 biến R2 thì mới upload được. */
  isConfigured() {
    const c = this.getEffectiveConfig();
    return Boolean(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket && c.publicUrl);
  }

  /** Trạng thái an toàn để trả ra ngoài: KHÔNG BAO GIỜ chứa key/secret. */
  getStatus() {
    const c = this.getEffectiveConfig();
    return {
      configured: this.isConfigured(),
      bucket: c.bucket,
      publicUrl: c.publicUrl,
      source: c.source,
    };
  }

  /** Endpoint S3 của R2: https://<account-id>.r2.cloudflarestorage.com */
  r2Endpoint() {
    return `https://${this.getEffectiveConfig().accountId}.r2.cloudflarestorage.com`;
  }

  /**
   * Key trong bucket cho 1 URL gốc: hash SHA-256 của URL (chuỗi gốc,
   * không lowercase vì path URL phân biệt hoa/thường) + đuôi file.
   * vd images/9f/9f3a...c1.jpg. Cùng URL -> cùng key (không upload trùng).
   */
  async imageKeyForUrl(sourceUrl) {
    const url = String(sourceUrl ?? '').trim();
    const hash = await sha256Hex(url);
    let ext = '.jpg';
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|svg)$/i);
      if (m) ext = m[1].toLowerCase() === 'jpeg' ? '.jpg' : `.${m[1].toLowerCase()}`;
    } catch { /* URL hỏng: key vẫn tính được từ hash, upload sẽ lỗi sau */ }
    return `images/${hash.slice(0, 2)}/${hash}${ext}`;
  }

  /** URL công khai trên Cloudflare cho 1 key trong bucket. */
  publicUrlForKey(key) {
    return `${this.getEffectiveConfig().publicUrl}/${key}`;
  }

  /**
   * Tải 1 ảnh từ URL gốc rồi upload lên R2, trả URL công khai Cloudflare.
   * Đã có trong cache thì trả ngay không gọi lại. Lỗi tải/upload thì
   * throw CloudflareImagesError (bên gọi giữ link gốc + warning).
   */
  async uploadImage(sourceUrl) {
    const url = String(sourceUrl ?? '').trim();
    if (!url) throw new CloudflareImagesError('invalid_url', 'URL ảnh trống.');
    if (!this.isConfigured()) {
      throw new CloudflareImagesError('r2_not_configured', 'Chưa cấu hình Cloudflare R2 (xem .env.example: CLOUDFLARE_R2_*) — giữ link ảnh gốc.');
    }
    const cached = this.urlCache.get(url);
    if (cached) return cached;
    // 1. Tải ảnh gốc (20s, tối đa 20MB).
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'GET' }, this.fetchFn, R2_IMAGE_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof CloudflareImagesError) throw e;
      throw new CloudflareImagesError('r2_download_failed', `Không tải được ảnh gốc ${url} (${e?.message ?? 'lỗi mạng'}) — giữ link gốc.`);
    }
    if (!res.ok) {
      throw new CloudflareImagesError('r2_download_failed', `Không tải được ảnh gốc ${url} (HTTP ${res.status}) — giữ link gốc.`);
    }
    const contentType = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : '';
    if (contentType && /^text\/html/i.test(contentType)) {
      throw new CloudflareImagesError('r2_download_failed', `Ảnh gốc ${url} trả về trang HTML (có thể link lỗi/trang chặn bot) — giữ link gốc.`);
    }
    let bytes;
    try {
      const buf = await res.arrayBuffer();
      bytes = new Uint8Array(buf);
    } catch (e) {
      throw new CloudflareImagesError('r2_download_failed', `Không đọc được ảnh gốc ${url} (${e?.message ?? 'lỗi đọc'}) — giữ link gốc.`);
    }
    if (!bytes.length) {
      throw new CloudflareImagesError('r2_download_failed', `Ảnh gốc ${url} rỗng — giữ link gốc.`);
    }
    if (bytes.length > R2_MAX_IMAGE_BYTES) {
      throw new CloudflareImagesError('r2_download_failed', `Ảnh gốc ${url} quá lớn (${Math.round(bytes.length / 1024 / 1024)}MB > 20MB) — giữ link gốc.`);
    }
    // 2. Upload lên R2 bằng PUT + SigV4.
    const key = await this.imageKeyForUrl(url);
    const type = (contentType && /^image\//i.test(contentType)) ? contentType.split(';')[0].trim() : 'image/jpeg';
    const publicUrl = await this.putObject(key, bytes, type);
    cachePut(this.urlCache, url, publicUrl);
    return publicUrl;
  }

  /**
   * PUT 1 object lên R2 (S3-compatible API, ký SigV4). Trả URL công khai.
   * Header ký theo thứ tự alphabet: content-type, host, x-amz-content-sha256, x-amz-date.
   */
  async putObject(key, bytes, contentType) {
    const cfg = this.getEffectiveConfig();
    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    const endpoint = `https://${host}/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const payloadHash = await sha256Hex(bytes);
    const { amzDate, dateStamp } = amzDates();
    // SigV4 requires both lists to use lowercase header names in alphabetical order.
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const canonicalRequest = [
      'PUT',
      `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join('\n');
    const kDate = await hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, 'auto');
    const kService = await hmacSha256(kRegion, 's3');
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signature = bytesToHex(await hmacSha256(kSigning, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    let res;
    try {
      res = await fetchWithTimeout(endpoint, {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'x-amz-date': amzDate,
          'x-amz-content-sha256': payloadHash,
          'Content-Type': contentType,
        },
        body: bytes,
      }, this.fetchFn, R2_IMAGE_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof CloudflareImagesError) throw e;
      throw new CloudflareImagesError('r2_upload_failed', `Không upload được ảnh lên R2 (${e?.message ?? 'lỗi mạng'}) — giữ link gốc.`);
    }
    if (!res.ok) {
      throw new CloudflareImagesError('r2_upload_failed', `Upload lên R2 lỗi (HTTP ${res.status}) — kiểm tra lại Access Key/Secret/bucket/quyền, ảnh giữ link gốc.`);
    }
    return this.publicUrlForKey(key);
  }

  /**
   * Upload tuần tự từng ảnh trong danh sách. Trả {images, uploaded,
   * warnings}: images là danh sách URL sau khi thay (ảnh upload được ->
   * URL Cloudflare, ảnh lỗi / chưa cấu hình -> giữ link gốc);
   * uploaded là số ảnh đã lên Cloudflare; warnings là các cảnh báo để
   * endpoint đính kèm vào kết quả. KHÔNG throw khi R2 chưa cấu hình
   * hay từng ảnh lỗi — chỉ throw khi lỗi lập trình (urls không phải mảng).
   */
  async uploadImages(urls) {
    const list = Array.isArray(urls) ? urls.map((u) => String(u ?? '').trim()).filter(Boolean) : [];
    if (!list.length) return { images: [], uploaded: 0, warnings: [] };
    if (!this.isConfigured()) {
      return {
        images: list,
        uploaded: 0,
        warnings: ['Chưa cấu hình Cloudflare R2 (CLOUDFLARE_R2_* trong .env) — giữ link ảnh gốc của trang bán lẻ. Xem README.md mục "Ảnh trên Cloudflare (R2)".'],
      };
    }
    const images = [];
    const warnings = [];
    let uploaded = 0;
    for (const url of list) {
      // Ảnh đã có trong cache (crawl lại cùng URL) thì không tính là
      // upload mới — uploadImages chỉ đếm số ảnh VỪA upload trong lần
      // gọi này.
      const wasCached = this.urlCache.has(url);
      try {
        const next = await this.uploadImage(url);
        images.push(next);
        if (next !== url && !wasCached) uploaded++;
      } catch (e) {
        images.push(url);
        warnings.push(e?.message ? String(e.message) : `Không upload được ảnh ${url} lên R2 — giữ link gốc.`);
      }
    }
    return { images, uploaded, warnings };
  }
}

/** Singleton dùng chung cho dev-server và Workers. */
export const defaultCloudflareImagesRuntime = new CloudflareImagesRuntime();

export function applyEnvToImagesRuntime(runtime, env) {
  return runtime.applyEnv(env);
}

export default { CloudflareImagesRuntime, defaultCloudflareImagesRuntime, pickR2Env };
