// scripts/smoke-soho.mjs — Smoke-test Soho Home + xuất CSV theo template.
// Dùng record Soho Home thật (trang thật đã fetch 13/11/2026: Cavern $1,470,
// Catherine Rug $2,450) + template eBay thật category 20563 user gửi.
// Chạy: node scripts/smoke-soho.mjs
// Ghi file CSV mẫu ra /tmp/smoke-soho/ để kiểm bằng mắt / upload thử.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  parseEbayTemplate, parseImport, groupProductsByTheme, buildEbayTemplateCsv, parseCsvText,
} from '../public/core.js';
import { MemoryStore, createApiKey, handleRequest } from '../server/api.mjs';

const templateText = readFileSync(
  new URL('../../user/files/eBay-category-listing-template-Th_ng_11-13-2026-11-37-19.csv', import.meta.url),
  'utf-8',
);
const template = parseEbayTemplate(templateText);

const records = [
  {
    source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/cavern-side-table',
    source_product_id: 'cavern-side-table', brand: 'Soho Home', title: 'Cavern Side Table',
    description_text: 'A square top crafted from a mix of travertine and marble.',
    images: ['https://assets.sohohome.com/images/original/296830-79940020-listingjpg.jpg'],
    breadcrumb: ['Furniture', 'Side Tables'],
    attributes: { material: 'Ash Wood, MDF, cement board, Grey Pesco Marble' },
    specs: { Dimensions: 'H45 x W50 x D50cm / H18 x W20 x D20"', Material: 'Ash Wood, MDF, cement board, Grey Pesco Marble', Weight: '15kg / 33.1lbs' },
    variants: [{ options: {}, price: 1470, compare_at_price: 2095, in_stock: true }],
  },
  {
    source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/catherine-rug-navy-round',
    source_product_id: 'catherine-rug-navy-round', brand: 'Soho Home', title: 'Catherine Rug Navy, Round, 200 x 200cm',
    description_text: 'Hand-knotted in India by skilled artisans.',
    images: ['https://assets.sohohome.com/images/original/342214-72746086-listingjpg.jpg'],
    breadcrumb: ['Furniture', 'Rugs'],
    attributes: { material: '100% Wool' },
    specs: { Composition: 'Pile: 100% Wool Base: 100% Cotton', Dimensions: 'H200 x W200 x D3cm' },
    variants: [{ options: { Size: '200 x 200cm' }, price: 2450, in_stock: true }],
  },
  {
    source_site: 'sohohome.com', source_url: 'https://www.sohohome.com/us/products/velvet-throw-pillow',
    source_product_id: 'velvet-throw-pillow', brand: 'Soho Home', title: 'Soho Home Velvet Throw Pillow',
    description_text: 'Soft velvet cushion',
    images: ['https://assets.sohohome.com/images/pillow1.jpg'],
    breadcrumb: ['Furniture', 'Cushions'],
    attributes: { material: '100% Cotton' },
    specs: { Dimensions: 'H45 x W45 x D15cm / H18 x W18 x D6"' },
    variants: [{ options: { Size: '18 x 18 in', Color: 'Navy' }, price: 150, in_stock: true }],
  },
];

const store = new MemoryStore();
const { key } = await createApiKey(store, 'smoke-soho');
const pingNoKey = await handleRequest(store, { method: 'GET', path: '/api/ingest/ping', headers: {} });
console.log('ping không khóa:', pingNoKey.status, JSON.stringify(pingNoKey.json));
const ping = await handleRequest(store, { method: 'GET', path: '/api/ingest/ping', headers: { authorization: `Bearer ${key}` } });
console.log('ping có khóa:', ping.status, JSON.stringify(ping.json));
const ingest = await handleRequest(store, {
  method: 'POST', path: '/api/ingest/records',
  headers: { authorization: `Bearer ${key}` }, body: { records },
});
console.log('ingest:', ingest.status, JSON.stringify(ingest.json.stats));
const boot = await handleRequest(store, { method: 'GET', path: '/api/bootstrap', headers: {} });
const products = boot.json.products;
console.log('bootstrap products:', products.map((p) => `${p.title} — $${p.price} (${p.source_site})`).join(' | '));

const groups = groupProductsByTheme(products);
console.log('nhóm:', groups.map((g) => `${g.key} (${g.label}): ${g.products.length}`).join(' ; '));

mkdirSync('/tmp/smoke-soho', { recursive: true });
for (const g of groups) {
  if (g.categoryId !== template.categoryId) {
    console.log(`bỏ qua nhóm ${g.key}: categoryId ${g.categoryId ?? '(chưa có)'} không khớp template ${template.categoryId} — cần template riêng của danh mục đó`);
    continue;
  }
  const csv = buildEbayTemplateCsv(g.products, template, { markupPct: 0, ebayFeePct: 0, roundTo99: false });
  const rows = parseCsvText(csv);
  if (JSON.stringify(rows[1]) !== JSON.stringify(template.headers)) throw new Error(`header nhóm ${g.key} không khớp template`);
  const file = `/tmp/smoke-soho/ebay-${template.categoryId}-${g.key}.csv`;
  writeFileSync(file, csv);
  const dataRow = rows[2 + template.infoRows.length];
  const col = (n) => template.headers.findIndex((h) => h.replace(/^\*/, '').replace(/\(.*$/, '') === n);
  console.log(`xuất ${file}: ${rows.length} dòng (header + info + ${rows.length - 2 - template.infoRows.length} dòng SP), Title="${dataRow[col('Title')]}", Type="${dataRow[col('C:Type')]}", Brand="${dataRow[col('C:Brand')]}", StartPrice=${dataRow[col('StartPrice')]}`);
}
console.log('SMOKE-OK');
