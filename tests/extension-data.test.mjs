import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/src/dist/content.js', import.meta.url), 'utf8');

// Run the real content-script message entry point against a product page and
// its Shopify JSON response, without requiring a browser or live retailer.
async function extractPage({ shopify = null, availability = 'https://schema.org/InStock' } = {}) {
  const url = new URL('https://shop.example/products/linen-shirt');
  const ld = {
    '@type': 'Product', name: 'Linen shirt', description: 'A linen shirt.',
    image: 'https://shop.example/shirt.jpg',
    offers: { price: 90, priceCurrency: 'GBP', ...(availability == null ? {} : { availability }) },
  };
  let listener;
  const sandbox = {
    URL, URLSearchParams, console,
    location: url,
    fetch: async (path) => {
      assert.equal(path, '/products/linen-shirt.js');
      return { ok: Boolean(shopify), json: async () => shopify };
    },
    document: {
      title: 'Linen shirt',
      body: { innerText: 'Linen shirt', classList: { contains: () => false } },
      querySelector: () => null,
      querySelectorAll: (selector) => selector === 'script[type="application/ld+json"]'
        ? [{ textContent: JSON.stringify(ld) }] : [],
    },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content.js' });
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script did not respond')), 3000);
    listener({ type: 'EXTRACT_AI_PAGE' }, {}, (result) => {
      clearTimeout(timer);
      resolve(JSON.parse(JSON.stringify(result)));
    });
  });
  assert.equal(response.ok, true, response.error);
  return response.page;
}

function shopifyProduct() {
  return {
    id: 123, vendor: 'Example', options: ['Colour', 'Size', 'Fit'],
    images: ['https://shop.example/shirt.jpg'],
    variants: [
      { option1: 'Blue', option2: 'M', option3: 'Regular', price: 9000, compare_at_price: 10000, available: true, sku: 'BLUE-M', barcode: '012345678905', featured_image: { src: 'https://shop.example/blue.jpg' } },
      { option1: 'Red', option2: 'S', option3: 'Petite', price: 7000, available: true, sku: 'RED-S' },
      { option1: 'Black', option2: 'L', option3: 'Regular', price: 4000, available: false, sku: 'BLACK-L' },
    ],
  };
}

test('extension upload preserves original variant options, identifiers, currency and image', async () => {
  const page = await extractPage({ shopify: shopifyProduct() });
  assert.equal(page.sourceProductId, '123');
  assert.deepEqual(page.option_names, ['Colour', 'Size', 'Fit']);
  assert.equal(page.variants.length, 3);
  assert.deepEqual(page.variants[0], {
    options: { Colour: 'Blue', Size: 'M', Fit: 'Regular' },
    size: 'M', color: 'Blue', extra_options: { Fit: 'Regular' },
    sku: 'BLUE-M', upc: '012345678905', price: 90, compareAt: 100,
    currency: 'GBP', in_stock: true, stock_qty: null,
    image: 'https://shop.example/blue.jpg',
  });
  assert.equal(page.variants[2].in_stock, false);
  assert.deepEqual(page.flags, { price_estimated: false });
  assert.equal(page.crawl_truncated, false);
});

test('extension summary uses cheapest available variant, preserving each variant price', async () => {
  const page = await extractPage({ shopify: shopifyProduct() });
  assert.equal(page.price, 70);
  assert.equal(page.currency, 'GBP');
  assert.deepEqual(page.variants.map((v) => v.price), [90, 70, 40]);
});

test('extension does not invent availability when a retailer omits it', async () => {
  const shopify = shopifyProduct();
  delete shopify.variants[0].available;
  const page = await extractPage({ shopify });
  assert.equal(page.variants[0].in_stock, null);
  const generic = await extractPage({ availability: null });
  assert.equal(generic.variants[0].in_stock, null);
  assert.equal(generic.flags.price_estimated, true);
});

test('generic fallback respects explicit sold-out stock from JSON-LD', async () => {
  const page = await extractPage({ availability: 'https://schema.org/OutOfStock' });
  assert.equal(page.variants[0].in_stock, false);
});
