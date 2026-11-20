import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseSohoDetailsText, ruleBasedExtractPage, normalizeAiExtractedPage } from '../server/ai.mjs';
import { tilneyLive } from './fixtures/soho-live-ax.mjs';
import { remiKnownSpecs, remiKnownPanel, remiDescriptionExcerpt } from './fixtures/remi-known-details.mjs';

const content = readFileSync(new URL('../extension/src/dist/content.js', import.meta.url), 'utf8');

async function extractSoho({ color = null, sku = tilneyLive.sku, url = tilneyLive.url, initialDetails = '', lazyDetails = '', expanded = false, unavailable = '', relatedUnavailable = false } = {}) {
  const pageUrl = new URL(url);
  const ld = {
    '@type': 'Product', name: color ? `Tilney Square Cushion, ${color}` : tilneyLive.title,
    sku, ...(color ? { color } : {}), image: 'https://assets.sohohome.com/images/original/tilney-1.jpg',
    offers: { price: 280, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  };
  const image = (i, related = false) => ({
    src: `https://assets.sohohome.com/images/original/${related ? 'related' : 'tilney'}-${i}.jpg`,
    naturalWidth: 1100,
    getAttribute: () => null,
    closest: (selector) => related && selector.includes('#related-products') ? {} : null,
  });
  const gallery = Array.from({ length: tilneyLive.galleryCount }, (_, i) => image(i + 1));
  const related = Array.from({ length: tilneyLive.relatedCount }, (_, i) => image(i + 1, true));
  const panel = { innerText: initialDetails, textContent: initialDetails };
  let clicks = 0;
  const button = {
    textContent: 'Details & Dimensions', disabled: false,
    getAttribute: (name) => name === 'aria-expanded' ? String(expanded) : null,
    click: () => { clicks++; panel.innerText = lazyDetails; panel.textContent = lazyDetails; },
  };
  const links = tilneyLive.swatches.map((swatch) => ({
    textContent: swatch.label, getAttribute: () => swatch.url, closest: () => null,
  }));
  const status = { textContent: unavailable, closest: () => relatedUnavailable ? {} : null };
  const main = { querySelectorAll: () => unavailable ? [status] : [] };
  let listener;
  const sandbox = {
    URL, console, location: pageUrl,
    // Simulate the lazy render between checks without a real two-second delay.
    setTimeout: (callback) => {
      if (expanded) panel.innerText = panel.textContent = lazyDetails;
      queueMicrotask(callback);
      return 1;
    },
    fetch: async () => { throw new Error('Reader must not call a private product endpoint'); },
    document: {
      title: ld.name,
      body: { innerText: tilneyLive.closedText, classList: { contains: () => false } },
      querySelector: (selector) => selector === '#product-detail-extra-content' ? panel : selector === 'main' ? main : null,
      querySelectorAll: (selector) => {
        if (selector === 'script[type="application/ld+json"]') return [{ textContent: JSON.stringify(ld) }];
        if (selector === 'main figure img' || selector === 'img') return [...gallery, ...related];
        if (selector === 'button, [role="button"]') return [button];
        if (selector === 'main a[href]') return links;
        return [];
      },
    },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(content, sandbox);
  const result = await new Promise((resolve) => listener({ type: 'EXTRACT_AI_PAGE' }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  return { page: JSON.parse(JSON.stringify(result.page)), clicks };
}

test('closed lazy details panel does not turn delivery/cart controls into a product description', () => {
  const out = parseSohoDetailsText('Tilney Square Cushion Green Product information Details & Dimensions Delivery & Returns Add Add to basket Delivery note Explore the range Cotton Green');
  assert.equal(out.description, null);
  assert.deepEqual(out.specs, {});
});

test('Tilney live structure: keep eight gallery images and selected Green; do not read related range images', async () => {
  const { page, clicks } = await extractSoho();
  assert.equal(page.images.length, 8);
  assert.ok(page.images.every((url) => !url.includes('related-')));
  assert.equal(page.variants[0].options.Color, 'Green');
  assert.equal(page.variants[0].sku, '78134985');
  assert.equal(page.sourceProductId, 'tilney-square-cushion', 'preserve existing URL identity and seller edits');
  assert.equal(page.description, null);
  assert.equal(page.specs.Dimensions, undefined, 'missing panel data stays missing');
  assert.equal(clicks, 1, 'only the named details button is opened');
});

test('Soho reads specs and description only after the details panel has actually rendered', async () => {
  // Synthetic panel values test parsing, not dimensions claimed for Tilney.
  const { page } = await extractSoho({ lazyDetails: 'Details & Dimensions\nA sample cushion description for the parser.\nDimensions\nH40 x W40cm\nMaterial\nCotton\nCare instructions\nDry clean only\nDelivery & Returns\nAdd to basket' });
  assert.equal(page.description, 'A sample cushion description for the parser.');
  assert.equal(page.specs.Dimensions, 'H40 x W40cm');
  assert.equal(page.specs.Material, 'Cotton');
  assert.equal(page.specs['Care instructions'], 'Dry clean only');
  assert.ok(!page.description.includes('Delivery'));
});

test('Soho preserves explicit selected Ochre and URL identity without inventing other variants', async () => {
  const { page } = await extractSoho({ color: 'Ochre', sku: '78134992', url: tilneyLive.swatches[1].url });
  assert.equal(page.variants.length, 1);
  assert.equal(page.variants[0].options.Color, 'Ochre');
  assert.equal(page.variants[0].sku, '78134992');
  assert.equal(page.sourceProductId, 'tilney-square-cushion-78134992');
});

test('Soho keeps a short existing dimensions field and leaves the open panel alone', async () => {
  const { page, clicks } = await extractSoho({ initialDetails: 'Dimensions\n50 x 50cm' });
  assert.equal(page.specs.Dimensions, '50 x 50cm');
  assert.equal(page.description, null);
  assert.equal(clicks, 0);
});

test('Soho waits for an already expanded lazy panel without closing it', async () => {
  const { page, clicks } = await extractSoho({ expanded: true, lazyDetails: 'Dimensions\n50 x 50cm' });
  assert.equal(page.specs.Dimensions, '50 x 50cm');
  assert.equal(clicks, 0);
});

test('Soho uses the selected SKU swatch before a conflicting title suffix', async () => {
  const { page } = await extractSoho({ sku: '78134992', url: tilneyLive.swatches[1].url });
  assert.equal(page.variants[0].options.Color, 'Ochre');
  assert.equal(page.variants[0].sku, '78134992');
});

test('visible product discontinued status overrides stale JSON-LD InStock', async () => {
  const { page } = await extractSoho({ unavailable: 'This product has been discontinued.' });
  assert.equal(page.variants[0].in_stock, false);
});

test('related product discontinued status does not change the current product stock', async () => {
  const { page } = await extractSoho({ unavailable: 'This product has been discontinued.', relatedUnavailable: true });
  assert.equal(page.variants[0].in_stock, true);
});

test('Remi known panel keeps assembled/base/certification values separate in extension extraction', async () => {
  const { page } = await extractSoho({ initialDetails: remiKnownPanel });
  assert.deepEqual(page.specs, remiKnownSpecs);
  assert.equal(page.description, remiDescriptionExcerpt);
});

test('Remi known panel boundaries survive server parsing of flattened and inline-label text', () => {
  for (const text of [remiKnownPanel, remiKnownPanel.replace(/\n/g, ' '),
    ['Details & Dimensions', `${remiDescriptionExcerpt} Download tearsheet`,
      ...Object.entries(remiKnownSpecs).map(([label, value]) => `${label}: ${value}`), 'Delivery & Returns'].join('\n')]) {
    const parsed = parseSohoDetailsText(text);
    assert.deepEqual(parsed.specs, remiKnownSpecs);
    assert.equal(parsed.description, remiDescriptionExcerpt);
  }
});

test('Soho description cleanup removes a trailing tearsheet control without cutting product prose', async () => {
  const text = `${remiDescriptionExcerpt} Download tearsheet`;
  const source = { sourceSite: 'SohoHome', url: 'https://www.sohohome.com/us/products/remi-stone-table-lamp',
    title: 'Remi Stone Table Lamp', price: 100, currency: 'USD', images: [], description: text, pageText: remiKnownPanel };
  assert.equal(ruleBasedExtractPage(source).extracted.description, remiDescriptionExcerpt);
  assert.equal(normalizeAiExtractedPage({ description: text }, source).extracted.description, remiDescriptionExcerpt);
  assert.equal(parseSohoDetailsText(`Details & Dimensions ${text}`).description, remiDescriptionExcerpt);
  const prose = 'The phrase Download tearsheet appears on the product information control.';
  assert.equal(normalizeAiExtractedPage({ description: prose }, source).extracted.description, prose);
  const { page } = await extractSoho({ initialDetails: `Details & Dimensions\n${text}` });
  assert.equal(page.description, remiDescriptionExcerpt);
});
