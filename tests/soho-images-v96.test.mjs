// tests/soho-images-v96.test.mjs â€” áº¢nh Soho Home: cÃ o Ä‘á»§ gallery, tá»‘i Ä‘a 12 (v9.6).
// Lá»—i user bÃ¡o 18/11/2026: cÃ o trang Soho chá»‰ Ä‘Æ°á»£c 1 áº£nh. NguyÃªn nhÃ¢n:
// readSohoHome() chá»‰ láº¥y ld.image (JSON-LD thÆ°á»ng chá»‰ cÃ³ 1 áº£nh chÃ­nh)
// vÃ  buildCsvRecord() Æ°u tiÃªn read.images nÃªn gallery trong DOM bá»‹ bá».
// v9.6: reader láº¥y Ä‘á»§ gallery (JSON-LD trÆ°á»›c, rá»“i áº£nh assets.sohohome.com
// trong DOM), dedupe theo tÃªn file gá»‘c sau "/images/original/" (cÃ¹ng áº£nh
// á»Ÿ nhiá»u crop chá»‰ tÃ­nh 1 láº§n, gÃ³c khÃ¡c nhau giá»¯ Ä‘á»§), tá»‘i Ä‘a 12 áº£nh;
// prompt AI gá»­i 12 áº£nh thay vÃ¬ 10; R2 upload Ä‘á»§ 12; CSV PicURL Ä‘á»§ 12.
// KHÃ”NG dÃ¹ng sá»‘ trong tÃªn file áº£nh lÃ m SKU (test Fleur v9.5 váº«n khÃ³a).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAiExtractPagePrompt,
  normalizeAiExtractedPage,
  ruleBasedExtractPage,
} from '../server/ai.mjs';
import { CloudflareImagesRuntime } from '../server/cloudflare-images.mjs';
import {
  normalizeRecord,
  parseEbayTemplate,
  parseCsvText,
  templateColumnIndex,
  groupProductsByTheme,
  buildGroupedEbayCsvs,
  applyTaxonomyResolutions,
  calcSellPrice,
} from '../public/core.js';
import {
  FLEUR_URL,
  FLEUR_LISTING_IMAGE,
  FLEUR_IMAGES,
  FLEUR_TITLE,
  FLEUR_PRICE,
  makeFleurRawA,
} from './fixtures/fleur-table-lamp-raw.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const contentJs = readFileSync(path.join(repo, 'extension/src/dist/content.js'), 'utf8');
const template = parseEbayTemplate(readFileSync(path.join(repo, 'public/templates/ebay-20563.csv'), 'utf8'));
const config = { markupPct: 0, ebayFeePct: 0, shippingCost: 0, taxPct: 0, roundTo99: false };

// ---- MÃ´ phá»ng trang Soho Home trong VM Ä‘á»ƒ cháº¡y content.js tháº­t ---------
// content.js chá»‰ Ä‘Äƒng kÃ½ chrome.runtime.onMessage â€” gá»i listener
// EXTRACT_AI_PAGE rá»“i Ä‘á»£i sendResponse({ok, page}).

function fakeImg(src, opts = {}) {
  return {
    getAttribute: (name) => (name === 'data-zoom-src' || name === 'data-src' ? null : null),
    currentSrc: src,
    src,
    naturalWidth: opts.naturalWidth ?? 1100,
    closest: (sel) => {
      if (opts.otherProduct && sel === 'a[href]') {
        return { getAttribute: () => '/us/products/other-chair' };
      }
      if (opts.inNav && /nav|header|footer/.test(sel)) return {};
      return null;
    },
  };
}

function runExtractAiPage({ ldImage, imgs, bodyText }) {
  const ld = {
    '@type': 'Product',
    name: FLEUR_TITLE,
    image: ldImage,
    description: 'Fleur lamp test description.',
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: FLEUR_PRICE, availability: 'https://schema.org/InStock' },
  };
  const scriptNode = { textContent: JSON.stringify(ld) };
  const listeners = [];
  const sandbox = {
    console,
    // VM cá»§a Node khÃ´ng cÃ³ sáºµn URL/fetch â€” content.js dÃ¹ng cáº£ hai
    // (sohoImageKey/isOtherProductTile dÃ¹ng URL, extractCsvRecord dÃ¹ng
    // fetch lÃ m tham sá»‘ máº·c Ä‘á»‹nh). TrÃªn trÃ¬nh duyá»‡t tháº­t cáº£ hai Ä‘á»u cÃ³.
    URL,
    // content.js dÃ¹ng fetch lÃ m tham sá»‘ máº·c Ä‘á»‹nh (extractCsvRecord) â€” trang
    // Soho khÃ´ng gá»i fetch, chá»‰ cáº§n stub Ä‘á»ƒ khá»i ReferenceError trong VM.
    fetch: async () => { throw new Error('fetch khÃ´ng dÃ¹ng trong test Soho'); },
    location: {
      hostname: 'www.sohohome.com',
      pathname: '/us/products/fleur-table-lamp',
      href: FLEUR_URL,
      origin: 'https://www.sohohome.com',
    },
    document: {
      title: FLEUR_TITLE,
      body: {
        innerText: bodyText,
        textContent: bodyText,
        classList: { contains: () => false },
      },
      querySelectorAll: (sel) => {
        if (sel === 'script[type="application/ld+json"]') return [scriptNode];
        if (sel === 'img') return imgs;
        return [];
      },
      querySelector: () => null,
    },
    chrome: {
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
      tabs: { query: async () => [{ id: 1, url: FLEUR_URL }] },
      scripting: { executeScript: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(contentJs, sandbox, { filename: 'content.js' });
  assert.equal(listeners.length, 1, 'content.js Ä‘Äƒng kÃ½ Ä‘Ãºng 1 message listener');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EXTRACT_AI_PAGE khÃ´ng tráº£ lá»i')), 5000);
    listeners[0]({ type: 'EXTRACT_AI_PAGE' }, {}, (res) => {
      clearTimeout(timer);
      // Káº¿t quáº£ tá»« VM lÃ  object/array cá»§a realm khÃ¡c â€” deepStrictEqual
      // so sÃ¡nh prototype nÃªn pháº£i Ä‘Æ°a vá» realm host trÆ°á»›c khi assert.
      resolve(JSON.parse(JSON.stringify(res)));
    });
  });
}

const FLEUR_BODY_TEXT = [
  'Fleur Table Lamp', 'Regular Price $450', 'Price $315',
  'Details & Dimensions',
  'Fleur lamp takes its cue from the lights in the new Soho House Paris interiors: a modern mushroom lamp with a half-sphere shade on a cylindrical stem, giving off soft warm light. Milky-white glass and lacquered sprayed metals are formed into an Art Deco-inspired silhouette.',
  'Dimensions', 'H19.3 x W13.4 x D13.4" / H49 x W34 x D34cm',
  'Weight', '13.7 lbs / 6.2 kg', 'Assembly required', 'No',
  'Bulb type', 'E26', 'Wattage', '60W',
  'Care instructions', 'Wipe with a dry cloth. Do not use abrasives or solvents.',
  'Delivery & Returns', 'Delivery from 4 days',
].join('\n');

const fleurGalleryImgs = FLEUR_IMAGES.map((src) => fakeImg(src));

// v9.6 (content.js): JSON-LD chá»‰ cÃ³ 1 áº£nh, gallery DOM cÃ³ Ä‘á»§ 7 áº£nh Fleur.
test('v9.6 content.js: JSON-LD 1 áº£nh + gallery DOM -> EXTRACT_AI_PAGE tráº£ Ä‘á»§ 7 áº£nh Fleur, áº£nh listing Ä‘á»©ng Ä‘áº§u', async () => {
  const res = await runExtractAiPage({
    ldImage: FLEUR_LISTING_IMAGE,
    imgs: fleurGalleryImgs,
    bodyText: FLEUR_BODY_TEXT,
  });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.deepEqual(res.page.images, FLEUR_IMAGES, 'Ä‘á»§ 7 áº£nh gallery, Ä‘Ãºng thá»© tá»±, áº£nh listing Ä‘áº§u tiÃªn');
  assert.equal(res.page.price, FLEUR_PRICE, 'giÃ¡ váº«n 315');
  assert.equal(res.page.variants?.[0]?.sku ?? null, null, 'khÃ´ng bá»‹a SKU tá»« tÃªn file áº£nh');
});

test('v9.6 content.js: cÃ¹ng áº£nh á»Ÿ crop khÃ¡c + tile sáº£n pháº©m khÃ¡c + áº£nh nav bá»‹ loáº¡i, khÃ´ng tÃ­nh trÃ¹ng', async () => {
  const duplicateCrop = 'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=500%2cheight=500%2ctrim=0%3b0%3b0%3b0/images/original/219687-79971888-listingjpg.jpg';
  const otherTile = fakeImg('https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222/images/original/999999-other-chair-listingjpg.jpg', { otherProduct: true });
  const navImg = fakeImg('https://assets.sohohome.com/images/original/111111-logo-jpg.jpg', { inNav: true });
  const res = await runExtractAiPage({
    ldImage: FLEUR_LISTING_IMAGE,
    imgs: [...fleurGalleryImgs, fakeImg(duplicateCrop), otherTile, navImg],
    bodyText: FLEUR_BODY_TEXT,
  });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.deepEqual(res.page.images, FLEUR_IMAGES, 'crop trÃ¹ng cá»§a áº£nh listing khÃ´ng tÃ­nh thÃªm, tile gháº¿ khÃ¡c + áº£nh nav bá»‹ loáº¡i');
});

test('v9.6 content.js: gallery 14 áº£nh -> tá»‘i Ä‘a 12 áº£nh, áº£nh listing váº«n Ä‘á»©ng Ä‘áº§u', async () => {
  const many = Array.from({ length: 14 }, (_, i) => fakeImg(
    `https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222/images/original/30000${i}-test-angle-${i}jpg.jpg`,
  ));
  const res = await runExtractAiPage({ ldImage: FLEUR_LISTING_IMAGE, imgs: many, bodyText: FLEUR_BODY_TEXT });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.equal(res.page.images.length, 12, 'capped 12 áº£nh');
  assert.equal(res.page.images[0], FLEUR_LISTING_IMAGE, 'áº£nh listing chÃ­nh Ä‘á»©ng Ä‘áº§u');
  assert.ok(res.page.images.every((u) => u.startsWith('https://assets.sohohome.com/')), 'chá»‰ áº£nh Soho');
});

// ---- Prompt AI: 10 -> 12, chá»‘ng bá»‹a áº£nh váº«n giá»¯ (cap 24) -----------------

function twelveImages() {
  return Array.from({ length: 12 }, (_, i) => `https://assets.sohohome.com/img-${i}.jpg`);
}

test('v9.6 buildAiExtractPagePrompt: gá»­i Ä‘á»§ 12 áº£nh cho LLM (trÆ°á»›c Ä‘Ã¢y chá»‰ 10)', () => {
  const images = twelveImages();
  const { user } = buildAiExtractPagePrompt({ ...makeFleurRawA(), images });
  for (const u of images) assert.ok(user.includes(u), `prompt pháº£i chá»©a áº£nh ${u}`);
  const thirteen = [...images, 'https://assets.sohohome.com/img-12.jpg'];
  const capped = buildAiExtractPagePrompt({ ...makeFleurRawA(), images: thirteen });
  assert.ok(!capped.user.includes('img-12.jpg'), 'áº£nh thá»© 13 khÃ´ng gá»­i cho LLM (cap 12)');
  assert.ok(capped.user.includes('img-11.jpg'), 'áº£nh thá»© 12 váº«n gá»­i');
});

test('v9.6 normalizeAiExtractedPage: LLM tráº£ 12 áº£nh cÃ³ trong dá»¯ liá»‡u trang thÃ¬ giá»¯ Ä‘á»§ 12, áº£nh bá»‹a váº«n bá»‹ loáº¡i', () => {
  const images = twelveImages();
  const raw = { ...makeFleurRawA(), images };
  const { extracted } = normalizeAiExtractedPage({ price: 315, title: FLEUR_TITLE, images }, raw);
  assert.equal(extracted.images.length, 12, 'giá»¯ Ä‘á»§ 12 áº£nh tháº­t');
  const withFake = normalizeAiExtractedPage(
    { price: 315, title: FLEUR_TITLE, images: [...images, 'https://example.com/fake.jpg'] },
    raw,
  );
  assert.equal(withFake.extracted.images.length, 12, 'áº£nh bá»‹a ngoÃ i dá»¯ liá»‡u trang bá»‹ loáº¡i');
  assert.ok(!withFake.extracted.images.includes('https://example.com/fake.jpg'));
});

test('v9.6 ruleBasedExtractPage: Fleur váº«n Ä‘á»§ 7 áº£nh, áº£nh Ä‘áº§u lÃ  áº£nh listing', () => {
  const { extracted } = ruleBasedExtractPage(makeFleurRawA());
  assert.equal(extracted.images.length, 7, 'fixture Fleur cÃ³ 7 áº£nh');
  assert.equal(extracted.images[0], FLEUR_LISTING_IMAGE);
});

// ---- Cloudflare R2: Ä‘á»§ 12 áº£nh --------------------------------------------

const R2_ENV = {
  CLOUDFLARE_R2_ACCOUNT_ID: 'test-acct-123',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'test-key-id',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'test-secret-key',
  CLOUDFLARE_R2_BUCKET: 'csv-images',
  CLOUDFLARE_R2_PUBLIC_URL: 'https://images.tencongty.com',
};

function makeR2Fetch({ failUrls = [] } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const method = String(init.method ?? 'GET').toUpperCase();
    if (method === 'PUT' && String(url).includes('r2.cloudflarestorage.com')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (failUrls.some((f) => String(url).includes(f))) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    const bytes = new TextEncoder().encode(`fake-image-bytes:${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => ({}),
    };
  };
  fn.calls = calls;
  return fn;
}

test('v9.6 R2: uploadImages 12 áº£nh -> 12 link Cloudflare, Ä‘á»§ 12 PUT', async () => {
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const urls = twelveImages();
  const { images, uploaded, warnings } = await rt.uploadImages(urls);
  assert.equal(uploaded, 12, 'upload Ä‘á»§ 12 áº£nh');
  assert.deepEqual(warnings, []);
  assert.equal(images.length, 12);
  assert.ok(images.every((u) => u.startsWith('https://images.tencongty.com/images/')), 'cáº£ 12 Ä‘á»u thÃ nh link Cloudflare');
  assert.equal(new Set(images).size, 12, '12 link Cloudflare khÃ¡c nhau');
  assert.equal(fetchFn.calls.filter((c) => String(c.init?.method ?? 'GET').toUpperCase() === 'PUT').length, 12);
});

test('v9.6 R2: 12 áº£nh, 1 áº£nh lá»—i -> chá»‰ áº£nh Ä‘Ã³ giá»¯ link gá»‘c, 11 áº£nh cÃ²n láº¡i váº«n lÃªn', async () => {
  const fetchFn = makeR2Fetch({ failUrls: ['img-5.jpg'] });
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const urls = twelveImages();
  const { images, uploaded, warnings } = await rt.uploadImages(urls);
  assert.equal(uploaded, 11);
  assert.equal(images[5], urls[5], 'áº£nh lá»—i giá»¯ link gá»‘c');
  assert.ok(images.filter((u, i) => i !== 5).every((u) => u.startsWith('https://images.tencongty.com/images/')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /img-5\.jpg/);
});

// ---- CSV: PicURL Ä‘á»§ 12 áº£nh, ná»‘i báº±ng '|' á»Ÿ dÃ²ng Ä‘áº§u ----------------------

function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { headers: rows[1], row: rows[firstDataIdx] };
}

test('v9.6 CSV 19591: sáº£n pháº©m 12 áº£nh -> PicURL cÃ³ Ä‘Ãºng 12 URL ná»‘i báº±ng |, áº£nh listing Ä‘á»©ng Ä‘áº§u', () => {
  const raw = makeFleurRawA();
  const images = twelveImages();
  images[0] = FLEUR_LISTING_IMAGE;
  const { extracted } = ruleBasedExtractPage({ ...raw, images });
  assert.equal(extracted.images.length, 12);
  const { product } = normalizeRecord({
    source_site: 'sohohome.com',
    source_product_id: 'fleur-table-lamp',
    title: extracted.title,
    brand: 'Soho Home',
    price: extracted.price,
    currency: 'USD',
    images: extracted.images,
    description: extracted.description,
    specs: extracted.specs,
    variants: [{ options: {}, price: extracted.price, compare_at_price: 450, in_stock: true }],
  });
  assert.equal(product.images.length, 12);
  const groups = groupProductsByTheme([product]);
  const applied = applyTaxonomyResolutions([product], groups, [{
    groupKey: 'lighting',
    categoryId: '19591',
    categoryName: 'Lighting Kits',
    categoryPath: 'Home & Garden > Lamps > Lighting Kits',
    requiredAspects: [
      { name: 'Type', values: ['Table Lamp', 'Floor Lamp', 'Chandelier', 'Wall Light', 'Ceiling Light', 'Pendant Light'] },
      { name: 'Brand', values: [] },
    ],
    recommendedAspects: [{ name: 'Bulb Type', values: ['E26', 'E27', 'B22', 'GU10'] }],
  }]);
  assert.deepEqual(applied, { appliedGroups: 1, appliedProducts: 1 });
  const { files } = buildGroupedEbayCsvs([product], template, config, groups);
  const lampFile = files.find((f) => f.groupKey === 'lighting');
  assert.ok(lampFile, 'nhÃ³m Ä‘Ã¨n 19591 pháº£i cÃ³ file');
  const { headers, row } = firstDataRow(lampFile.csv);
  const col = (name) => row[templateColumnIndex(headers, name)];
  assert.equal(col('StartPrice'), calcSellPrice(FLEUR_PRICE, config).toFixed(2));
  const picUrls = (col('PicURL') ?? '').split('|');
  assert.equal(picUrls.length, 12, 'PicURL cÃ³ Ä‘Ãºng 12 áº£nh');
  assert.equal(picUrls[0], FLEUR_LISTING_IMAGE, 'PicURL báº¯t Ä‘áº§u báº±ng áº£nh listing chÃ­nh');
  assert.ok(picUrls.every((u) => u.startsWith('https://assets.sohohome.com/')));
});

// ---- String khÃ³a: reader + manifest v1.3.4 ---------------------------------

test('v9.6 extension: readSohoHome dÃ¹ng collectSohoHomeImages (khÃ´ng chá»‰ ld.image), manifest 1.4.0', () => {
  assert.ok(contentJs.includes('function collectSohoHomeImages('), 'cÃ³ hÃ m collectSohoHomeImages');
  assert.ok(contentJs.includes('function sohoImageKey('), 'cÃ³ hÃ m dedupe theo tÃªn file gá»‘c');
  assert.ok(contentJs.includes('/images/original/'), 'dedupe theo pháº§n sau /images/original/');
  assert.ok(contentJs.includes('collectSohoHomeImages(ld.image)'), 'readSohoHome láº¥y gallery qua collectSohoHomeImages');
  assert.ok(contentJs.includes('if (source === "SohoHome") return collectSohoHomeImages(fromLd);'), 'collectImages cÃ³ nhÃ¡nh Soho riÃªng');
  assert.ok(contentJs.includes('return urls.slice(0, 12);'), 'gallery tá»‘i Ä‘a 12 áº£nh');
  const m = JSON.parse(readFileSync(path.join(repo, 'extension/src/manifest.json'), 'utf8'));
  assert.equal(m.version, '1.4.0');
  const m2 = JSON.parse(readFileSync(path.join(repo, 'extension-v2/manifest.json'), 'utf8'));
  assert.equal(m2.version, '1.4.0', 'extension-v2 Ä‘Ã£ build láº¡i tá»« src (cháº¡y npm run build:extension)');
});
