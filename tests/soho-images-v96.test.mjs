// tests/soho-images-v96.test.mjs — Ảnh Soho Home: cào đủ gallery, tối đa 12 (v9.6).
// Lỗi user báo 18/11/2026: cào trang Soho chỉ được 1 ảnh. Nguyên nhân:
// readSohoHome() chỉ lấy ld.image (JSON-LD thường chỉ có 1 ảnh chính)
// và buildCsvRecord() ưu tiên read.images nên gallery trong DOM bị bỏ.
// v9.6: reader lấy đủ gallery (JSON-LD trước, rồi ảnh assets.sohohome.com
// trong DOM), dedupe theo tên file gốc sau "/images/original/" (cùng ảnh
// ở nhiều crop chỉ tính 1 lần, góc khác nhau giữ đủ), tối đa 12 ảnh;
// prompt AI gửi 12 ảnh thay vì 10; R2 upload đủ 12; CSV PicURL đủ 12.
// KHÔNG dùng số trong tên file ảnh làm SKU (test Fleur v9.5 vẫn khóa).
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

// ---- Mô phỏng trang Soho Home trong VM để chạy content.js thật ---------
// content.js chỉ đăng ký chrome.runtime.onMessage — gọi listener
// EXTRACT_AI_PAGE rồi đợi sendResponse({ok, page}).

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
    // VM của Node không có sẵn URL/fetch — content.js dùng cả hai
    // (sohoImageKey/isOtherProductTile dùng URL, extractCsvRecord dùng
    // fetch làm tham số mặc định). Trên trình duyệt thật cả hai đều có.
    URL,
    // content.js dùng fetch làm tham số mặc định (extractCsvRecord) — trang
    // Soho không gọi fetch, chỉ cần stub để khỏi ReferenceError trong VM.
    fetch: async () => { throw new Error('fetch không dùng trong test Soho'); },
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
  assert.equal(listeners.length, 1, 'content.js đăng ký đúng 1 message listener');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EXTRACT_AI_PAGE không trả lời')), 5000);
    listeners[0]({ type: 'EXTRACT_AI_PAGE' }, {}, (res) => {
      clearTimeout(timer);
      // Kết quả từ VM là object/array của realm khác — deepStrictEqual
      // so sánh prototype nên phải đưa về realm host trước khi assert.
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

// v9.6 (content.js): JSON-LD chỉ có 1 ảnh, gallery DOM có đủ 7 ảnh Fleur.
test('v9.6 content.js: JSON-LD 1 ảnh + gallery DOM -> EXTRACT_AI_PAGE trả đủ 7 ảnh Fleur, ảnh listing đứng đầu', async () => {
  const res = await runExtractAiPage({
    ldImage: FLEUR_LISTING_IMAGE,
    imgs: fleurGalleryImgs,
    bodyText: FLEUR_BODY_TEXT,
  });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.deepEqual(res.page.images, FLEUR_IMAGES, 'đủ 7 ảnh gallery, đúng thứ tự, ảnh listing đầu tiên');
  assert.equal(res.page.price, FLEUR_PRICE, 'giá vẫn 315');
  assert.equal(res.page.variants?.[0]?.sku ?? null, null, 'không bịa SKU từ tên file ảnh');
});

test('v9.6 content.js: cùng ảnh ở crop khác + tile sản phẩm khác + ảnh nav bị loại, không tính trùng', async () => {
  const duplicateCrop = 'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=500%2cheight=500%2ctrim=0%3b0%3b0%3b0/images/original/219687-79971888-listingjpg.jpg';
  const otherTile = fakeImg('https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222/images/original/999999-other-chair-listingjpg.jpg', { otherProduct: true });
  const navImg = fakeImg('https://assets.sohohome.com/images/original/111111-logo-jpg.jpg', { inNav: true });
  const res = await runExtractAiPage({
    ldImage: FLEUR_LISTING_IMAGE,
    imgs: [...fleurGalleryImgs, fakeImg(duplicateCrop), otherTile, navImg],
    bodyText: FLEUR_BODY_TEXT,
  });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.deepEqual(res.page.images, FLEUR_IMAGES, 'crop trùng của ảnh listing không tính thêm, tile ghế khác + ảnh nav bị loại');
});

test('v9.6 content.js: gallery 14 ảnh -> tối đa 12 ảnh, ảnh listing vẫn đứng đầu', async () => {
  const many = Array.from({ length: 14 }, (_, i) => fakeImg(
    `https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222/images/original/30000${i}-test-angle-${i}jpg.jpg`,
  ));
  const res = await runExtractAiPage({ ldImage: FLEUR_LISTING_IMAGE, imgs: many, bodyText: FLEUR_BODY_TEXT });
  assert.equal(res.ok, true, res.error ?? 'extract ok');
  assert.equal(res.page.images.length, 12, 'capped 12 ảnh');
  assert.equal(res.page.images[0], FLEUR_LISTING_IMAGE, 'ảnh listing chính đứng đầu');
  assert.ok(res.page.images.every((u) => u.startsWith('https://assets.sohohome.com/')), 'chỉ ảnh Soho');
});

// ---- Prompt AI: 10 -> 12, chống bịa ảnh vẫn giữ (cap 24) -----------------

function twelveImages() {
  return Array.from({ length: 12 }, (_, i) => `https://assets.sohohome.com/img-${i}.jpg`);
}

test('v9.6 buildAiExtractPagePrompt: gửi đủ 12 ảnh cho LLM (trước đây chỉ 10)', () => {
  const images = twelveImages();
  const { user } = buildAiExtractPagePrompt({ ...makeFleurRawA(), images });
  for (const u of images) assert.ok(user.includes(u), `prompt phải chứa ảnh ${u}`);
  const thirteen = [...images, 'https://assets.sohohome.com/img-12.jpg'];
  const capped = buildAiExtractPagePrompt({ ...makeFleurRawA(), images: thirteen });
  assert.ok(!capped.user.includes('img-12.jpg'), 'ảnh thứ 13 không gửi cho LLM (cap 12)');
  assert.ok(capped.user.includes('img-11.jpg'), 'ảnh thứ 12 vẫn gửi');
});

test('v9.6 normalizeAiExtractedPage: LLM trả 12 ảnh có trong dữ liệu trang thì giữ đủ 12, ảnh bịa vẫn bị loại', () => {
  const images = twelveImages();
  const raw = { ...makeFleurRawA(), images };
  const { extracted } = normalizeAiExtractedPage({ price: 315, title: FLEUR_TITLE, images }, raw);
  assert.equal(extracted.images.length, 12, 'giữ đủ 12 ảnh thật');
  const withFake = normalizeAiExtractedPage(
    { price: 315, title: FLEUR_TITLE, images: [...images, 'https://example.com/fake.jpg'] },
    raw,
  );
  assert.equal(withFake.extracted.images.length, 12, 'ảnh bịa ngoài dữ liệu trang bị loại');
  assert.ok(!withFake.extracted.images.includes('https://example.com/fake.jpg'));
});

test('v9.6 ruleBasedExtractPage: Fleur vẫn đủ 7 ảnh, ảnh đầu là ảnh listing', () => {
  const { extracted } = ruleBasedExtractPage(makeFleurRawA());
  assert.equal(extracted.images.length, 7, 'fixture Fleur có 7 ảnh');
  assert.equal(extracted.images[0], FLEUR_LISTING_IMAGE);
});

// ---- Cloudflare R2: đủ 12 ảnh --------------------------------------------

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

test('v9.6 R2: uploadImages 12 ảnh -> 12 link Cloudflare, đủ 12 PUT', async () => {
  const fetchFn = makeR2Fetch();
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const urls = twelveImages();
  const { images, uploaded, warnings } = await rt.uploadImages(urls);
  assert.equal(uploaded, 12, 'upload đủ 12 ảnh');
  assert.deepEqual(warnings, []);
  assert.equal(images.length, 12);
  assert.ok(images.every((u) => u.startsWith('https://images.tencongty.com/images/')), 'cả 12 đều thành link Cloudflare');
  assert.equal(new Set(images).size, 12, '12 link Cloudflare khác nhau');
  assert.equal(fetchFn.calls.filter((c) => String(c.init?.method ?? 'GET').toUpperCase() === 'PUT').length, 12);
});

test('v9.6 R2: 12 ảnh, 1 ảnh lỗi -> chỉ ảnh đó giữ link gốc, 11 ảnh còn lại vẫn lên', async () => {
  const fetchFn = makeR2Fetch({ failUrls: ['img-5.jpg'] });
  const rt = new CloudflareImagesRuntime(R2_ENV, fetchFn);
  const urls = twelveImages();
  const { images, uploaded, warnings } = await rt.uploadImages(urls);
  assert.equal(uploaded, 11);
  assert.equal(images[5], urls[5], 'ảnh lỗi giữ link gốc');
  assert.ok(images.filter((u, i) => i !== 5).every((u) => u.startsWith('https://images.tencongty.com/images/')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /img-5\.jpg/);
});

// ---- CSV: PicURL đủ 12 ảnh, nối bằng '|' ở dòng đầu ----------------------

function firstDataRow(csvText) {
  const rows = parseCsvText(csvText);
  const firstDataIdx = rows.findIndex((r) => r[0] === 'Add');
  return { headers: rows[1], row: rows[firstDataIdx] };
}

test('v9.6 CSV 19591: sản phẩm 12 ảnh -> PicURL có đúng 12 URL nối bằng |, ảnh listing đứng đầu', () => {
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
  assert.ok(lampFile, 'nhóm đèn 19591 phải có file');
  const { headers, row } = firstDataRow(lampFile.csv);
  const col = (name) => row[templateColumnIndex(headers, name)];
  assert.equal(col('StartPrice'), calcSellPrice(FLEUR_PRICE, config).toFixed(2));
  const picUrls = (col('PicURL') ?? '').split('|');
  assert.equal(picUrls.length, 12, 'PicURL có đúng 12 ảnh');
  assert.equal(picUrls[0], FLEUR_LISTING_IMAGE, 'PicURL bắt đầu bằng ảnh listing chính');
  assert.ok(picUrls.every((u) => u.startsWith('https://assets.sohohome.com/')));
});

// ---- String khóa: reader + manifest v1.3.4 ---------------------------------

test('v9.6 extension: readSohoHome dùng collectSohoHomeImages (không chỉ ld.image), manifest 1.3.7', () => {
  assert.ok(contentJs.includes('function collectSohoHomeImages('), 'có hàm collectSohoHomeImages');
  assert.ok(contentJs.includes('function sohoImageKey('), 'có hàm dedupe theo tên file gốc');
  assert.ok(contentJs.includes('/images/original/'), 'dedupe theo phần sau /images/original/');
  assert.ok(contentJs.includes('collectSohoHomeImages(ld.image)'), 'readSohoHome lấy gallery qua collectSohoHomeImages');
  assert.ok(contentJs.includes('if (source === "SohoHome") return collectSohoHomeImages(fromLd);'), 'collectImages có nhánh Soho riêng');
  assert.ok(contentJs.includes('return urls.slice(0, 12);'), 'gallery tối đa 12 ảnh');
  const m = JSON.parse(readFileSync(path.join(repo, 'extension/src/manifest.json'), 'utf8'));
  assert.equal(m.version, '1.3.7');
  const m2 = JSON.parse(readFileSync(path.join(repo, 'extension-v2/manifest.json'), 'utf8'));
  assert.equal(m2.version, '1.3.7', 'extension-v2 đã build lại từ src (chạy npm run build:extension)');
});
