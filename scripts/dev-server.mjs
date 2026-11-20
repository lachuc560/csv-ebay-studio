// scripts/dev-server.mjs — Dev server local (Node http, port 8787).
// Phục vụ file tĩnh từ public/ và route /api/* qua handleRequest + MemoryStore.
// CHỈ dùng dev local — không deploy bản này.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest, MAX_BODY_BYTES } from '../server/api.mjs';
import { LocalFileStore, resolveDataFilePath } from './local-store.mjs';
import { defaultAiRuntime, applyEnvToRuntime } from '../server/ai-providers.mjs';
import { defaultEbayTaxonomyRuntime, applyEnvToEbayRuntime } from '../server/ebay-taxonomy.mjs';
import { defaultCloudflareImagesRuntime, applyEnvToImagesRuntime } from '../server/cloudflare-images.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Load file .env ở gốc repo vào process.env (chỉ khi biến chưa có sẵn).
 *  Dạng KEY=VALUE, bỏ comment và dòng trống, giá trị có thể để trong "".
 *  KHÔNG log giá trị — key AI chỉ nằm trong bộ nhớ server. */
export async function loadDotEnv(envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')) {
  let text;
  try {
    text = await readFile(envPath, 'utf-8');
  } catch {
    return {};
  }
  const loaded = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key || value === '') continue;
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}

await loadDotEnv();
applyEnvToRuntime(defaultAiRuntime, process.env);
applyEnvToEbayRuntime(defaultEbayTaxonomyRuntime, process.env);
applyEnvToImagesRuntime(defaultCloudflareImagesRuntime, process.env);

// v6: dữ liệu lưu bền xuống file trên máy (data/local-data.json) để tắt
// Terminal mở lại vẫn còn sản phẩm + khóa crawl, khỏi crawl lại. Đổi file
// bằng biến môi trường CSV_STUDIO_DATA_FILE. MemoryStore thuần vẫn dùng
// trong test; bản deploy Cloudflare vẫn dùng D1.
const DATA_FILE = resolveDataFilePath();
const store = new LocalFileStore(DATA_FILE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, json) {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(body);
}

/** Parse req.url an toàn: Chrome/extension đôi khi gửi '//' hoặc '//api/...'
 *  — new URL('//', base) ném ERR_INVALID_URL và làm sập cả server (lỗi user gặp
 *  trên Node 26). Chuẩn hoá về '/...' rồi mới parse, parse lỗi thì trả 400. */
export function parseRequestUrl(rawUrl) {
  let raw = typeof rawUrl === 'string' && rawUrl ? rawUrl : '/';
  if (!raw.startsWith('/')) raw = `/${raw}`;
  // Gộp các dấu '/' đầu thành 1: '//' -> '/', '//api/x' -> '/api/x'.
  raw = `/${raw.replace(/^\/+/, '')}`;
  return new URL(raw, 'http://localhost');
}

async function serveStatic(req, res) {
  const url = parseRequestUrl(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relativePath = path.relative(PUBLIC_DIR, resolved);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end();
    return;
  }
  let url;
  try {
    url = parseRequestUrl(req.url);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res).catch((e) => {
      console.error(e);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error');
    });
    return;
  }
  // Route /api/* qua handleRequest (pure handler dùng chung với Workers).
  const chunks = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on('data', (chunk) => {
    if (bodyTooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      chunks.length = 0;
      sendJson(res, 413, { error: 'body_too_large' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (bodyTooLarge) return;
    const bodyText = Buffer.concat(chunks).toString('utf8');
    try {
      const { status, json } = await handleRequest(store, {
        method: req.method,
        // Giữ cả query string trong path để endpoint tra tay
        // (/api/ebay/category-suggestions?q=...) đọc được từ khoá.
        path: url.pathname + url.search,
        headers: req.headers,
        bodyText,
      });
      sendJson(res, status, json);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: 'server_error' });
    }
  });
  req.on('error', (e) => {
    console.error(e);
    if (!res.writableEnded) sendJson(res, 500, { error: 'server_error' });
  });
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Không mở thêm server: cổng ${PORT} đang được sử dụng.`);
  console.error(`Nếu CSV Studio đã chạy, mở http://localhost:${PORT}/ — không cần chạy npm run dev lần nữa.`);
  console.error('Muốn khởi động lại: dừng phiên tool đang chạy trước.');
  process.exitCode = 1;
});

server.listen(PORT, () => {
  const ai = defaultAiRuntime.getStatus();
  console.log(`csv-ebay-studio dev server: http://localhost:${PORT}/`);
  console.log(`Dữ liệu lưu tại: ${DATA_FILE}`);
  console.log(store.loadedAt
    ? `Đã tải lại ${store.listProducts().length} sản phẩm đã lưu (lưu lần cuối ${store.loadedAt}) — tắt Terminal mở lại vẫn còn.`
    : 'Chưa có dữ liệu đã lưu — crawl xong sẽ tự lưu xuống file trên máy.');
  console.log('API: /api/bootstrap, /api/ingest/ping, /api/ingest/records, /api/keys ...');
  console.log(ai.configured
    ? `AI: ${ai.provider}/${ai.model} — key từ ${ai.source === 'env' ? 'biến môi trường AI_API_KEY (.env)' : 'web'}`
    : 'AI: chưa có key — đang gợi ý theo luật (rule-based). Đặt AI_API_KEY trong .env hoặc dán key trong web (tab "AI gợi ý").');
  const ebay = defaultEbayTaxonomyRuntime.getStatus();
  console.log(ebay.configured
    ? `eBay Taxonomy: đã có khóa (${ebay.environment}, thị trường ${ebay.marketplace}) — nguồn: ${ebay.source === 'env' ? 'biến môi trường EBAY_APP_ID/EBAY_CERT_ID (.env)' : 'web'}`
    : 'eBay Taxonomy: chưa có khóa — nhóm chưa có template vẫn chỉ ra file nháp (v7). Đặt EBAY_APP_ID / EBAY_CERT_ID trong .env hoặc dán khóa trong web (tab "AI gợi ý" → mục eBay Taxonomy).');
  const images = defaultCloudflareImagesRuntime.getStatus();
  console.log(images.configured
    ? `R2: đã cấu hình bucket ${images.bucket} — ảnh sẽ được gửi lên R2 khi crawl.`
    : 'R2: chưa đủ cấu hình — ảnh giữ link gốc.');
});

export default server;
