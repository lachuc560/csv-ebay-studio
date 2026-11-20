// Manual browser QA only: in-memory fixtures, no real credentials or external requests.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { MemoryStore, handleRequest } from '../../server/api.mjs';
import Core from '../../public/core.js';

const store = new MemoryStore();
const product = Core.normalizeRecord({ source_site: 'shop.example', source_product_id: 'qa-lamp', title: 'QA Table Lamp',
  price: 100, currency: 'USD', brand: 'Fixture', description: 'Table lamp used to verify the local tool.',
  images: ['https://shop.example/lamp.jpg'], specs: { Type: 'Table Lamp', Voltage: '120 V' },
  variants: [{ sku: 'QA-RED', options: { Color: 'Red' }, price: 100, in_stock: true },
    { sku: 'QA-BLUE', options: { Color: 'Blue' }, price: 110, in_stock: true }],
}).product;
store.putProduct(product);
store.putMeta('config', JSON.stringify({ markupPct: 0, ebayFeePct: 0, roundTo99: false, ebayLocation: 'Austin, TX', dispatchTimeMax: 0, returnsAcceptedOption: 'ReturnsAccepted' }));
const category = { categoryId: '12345', categoryName: 'QA Lamps (fixture)', verifiedFromEbay: true,
  requiredAspects: [{ name: 'Type', values: ['Table Lamp'] }, { name: 'Brand', values: [] }, { name: 'Voltage', values: ['120 V'], aspectConstraint: { aspectMode: 'SELECTION_ONLY' } }],
  recommendedAspects: [{ name: 'Color', values: ['Red', 'Blue'], aspectConstraint: { aspectMode: 'SELECTION_ONLY' } }] };
const options = { ebayRuntime: { getCategoryDetails: async () => category, getStatus: () => ({ configured: true, environment: 'fixture', marketplace: 'EBAY_US' }) } };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let bodyText = '';
      for await (const chunk of req) bodyText += chunk;
      const { status, json } = await handleRequest(store, { method: req.method, path: url.pathname, bodyText }, options);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    } else {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
      const file = new URL(`../../public/${relative}`, import.meta.url);
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.html') ? 'text/html' : 'text/plain' });
      res.end(content);
    }
  } catch { res.writeHead(500); res.end('QA fixture error'); }
});
server.listen(8788, '127.0.0.1', () => console.log('Fixture-only UI QA: http://127.0.0.1:8788'));
