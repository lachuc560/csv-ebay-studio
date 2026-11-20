// scripts/push-crawl.mjs — Đẩy một lô record crawl lên tool qua POST /api/ingest/records.
// Chia chunk sao cho CÙNG một sản phẩm (cùng source_site|source_product_id)
// không bao giờ bị tách sang 2 chunk.
// CLI: node scripts/push-crawl.mjs <file.json> [--endpoint URL] [--key csvk_...]
//   env: CSV_STUDIO_ENDPOINT (mặc định http://localhost:8787), CSV_STUDIO_KEY
//   file JSON dạng {records:[...]} hoặc [...].

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_BYTES = 1_500_000;
export const DEFAULT_MAX_RECORDS = 200;

function productKey(record) {
  const site = String(record?.source_site ?? record?.source ?? '').trim().toLowerCase();
  const id = String(record?.source_product_id ?? record?.source_id ?? record?.id ?? '').trim();
  return `${site}|${id}`;
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

/**
 * Chia records thành chunk.
 * - Gom các record cùng sản phẩm (cùng source_site|source_product_id) thành một nhóm,
 *   nhóm không bao giờ bị tách.
 * - Chunk không vượt maxRecords và ước lượng bytes JSON không vượt maxBytes,
 *   trừ khi 1 sản phẩm đơn đã vượt giới hạn (nhóm đó đi một mình một chunk).
 */
export function chunkRecords(records, { maxBytes = DEFAULT_MAX_BYTES, maxRecords = DEFAULT_MAX_RECORDS } = {}) {
  const list = Array.isArray(records) ? records : [];
  // Gom theo sản phẩm, giữ thứ tự xuất hiện đầu tiên của mỗi sản phẩm.
  const groups = new Map();
  for (const record of list) {
    const key = productKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const chunks = [];
  let current = [];
  let currentBytes = byteLength('{"records":[]}');
  let currentCount = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentBytes = byteLength('{"records":[]}');
    currentCount = 0;
  };
  for (const group of groups.values()) {
    const groupBytes = byteLength(JSON.stringify(group));
    const groupCount = group.length;
    const wouldExceed = current.length > 0
      && (currentCount + groupCount > maxRecords || currentBytes + groupBytes > maxBytes);
    if (wouldExceed) flush();
    current.push(...group);
    currentCount += groupCount;
    currentBytes += groupBytes;
  }
  flush();
  return chunks;
}

/**
 * POST từng chunk tới {endpoint}/api/ingest/records, gom kết quả.
 * @param {object} opts
 * @param {Array} opts.records
 * @param {string} opts.endpoint - vd http://localhost:8787
 * @param {string} opts.apiKey - csvk_...
 * @param {function} [opts.fetchFn] - mặc định globalThis.fetch (test có thể inject)
 * @param {object} [opts.chunkOptions] - truyền cho chunkRecords
 */
export async function pushCrawl({ records, endpoint, apiKey, fetchFn, chunkOptions } = {}) {
  if (!endpoint) throw new Error('endpoint is required');
  if (!apiKey) throw new Error('apiKey is required');
  const fetchImpl = fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const base = String(endpoint).replace(/\/+$/, '');
  const chunks = chunkRecords(records, chunkOptions);
  const results = [];
  let imported = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const res = await fetchImpl(`${base}/api/ingest/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ records: chunk }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const code = data?.error ?? `http_${res.status}`;
      const error = new Error(`chunk ${i + 1}/${chunks.length} failed: ${code}`);
      error.code = code;
      error.status = res.status;
      error.chunkIndex = i;
      throw error;
    }
    imported += (data?.products ?? []).length;
    results.push({ index: i, records: chunk.length, response: data });
  }
  return { ok: true, chunks: results, totalRecords: (records ?? []).length, imported };
}

// ---- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { file: null, endpoint: process.env.CSV_STUDIO_ENDPOINT || 'http://localhost:8787', key: process.env.CSV_STUDIO_KEY || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--endpoint' && argv[i + 1]) args.endpoint = argv[++i];
    else if (a.startsWith('--endpoint=')) args.endpoint = a.slice('--endpoint='.length);
    else if (a === '--key' && argv[i + 1]) args.key = argv[++i];
    else if (a.startsWith('--key=')) args.key = a.slice('--key='.length);
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

async function main() {
  const { file, endpoint, key } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node scripts/push-crawl.mjs <file.json> [--endpoint URL] [--key csvk_...]');
    process.exit(1);
  }
  if (!key) {
    console.error('Missing API key: pass --key csvk_... or set CSV_STUDIO_KEY');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(records)) {
    console.error('File must contain {records:[...]} or [...]');
    process.exit(1);
  }
  try {
    const result = await pushCrawl({ records, endpoint, apiKey: key });
    for (const chunk of result.chunks) {
      const products = chunk.response?.products ?? [];
      const first = products[0];
      console.log(
        `chunk ${chunk.index + 1}/${result.chunks.length}: ${chunk.records} record(s) -> `
        + `${chunk.response?.ok ? 'ok' : 'fail'}`
        + (first ? `, "${first.title}": ${first.variants} variants, ${first.inStock} in stock` : '')
        + `, updated=${chunk.response?.updated ?? false}`,
      );
    }
    console.log(`done: ${result.totalRecords} record(s) in ${result.chunks.length} chunk(s), ${result.imported} product(s) imported/updated`);
  } catch (e) {
    console.error(`push failed: ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

export default { chunkRecords, pushCrawl };
