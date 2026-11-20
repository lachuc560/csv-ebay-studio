import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Core from '../public/core.js';
import { sellerExportConfig } from '../public/export-settings.js';

// Execute the actual export UI handlers with a small DOM boundary. Core CSV
// creation stays real; only browser downloads and the local API are simulated.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('// ---- Tab Xuất CSV');
const end = app.indexOf('// ---- Template eBay nhúng sẵn', start);
assert.ok(start >= 0 && end > start, 'export handlers must be present');
const source = app.slice(start, end);
const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));

function setup() {
  const elements = new Map();
  for (const id of ['categoryProductSelect', 'categoryIdInput', 'categoryPrepareBtn', 'categoryPrepareStatus',
    'categoryTemplatePreview', 'categoryTemplateForm', 'downloadCategoryCsvBtn', 'groupList']) {
    const events = new Map();
    elements.set(id, {
      value: '', innerHTML: '', textContent: '', className: '', disabled: id === 'downloadCategoryCsvBtn',
      hidden: false, events,
      addEventListener(type, listener) {
        events.set(type, [...(events.get(type) ?? []), listener]);
      },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
    });
  }
  const element = (id) => {
    assert.ok(elements.has(id), `unexpected element ${id}`);
    return elements.get(id);
  };
  const product = Core.normalizeRecord({
    source_site: 'sohohome.com', source_product_id: 'floria-ui-test',
    title: 'Floria Wall Light', brand: 'Soho Home', price: 175, currency: 'GBP',
    description: 'Marble wall light used for the export regression.',
    images: ['https://images.example/floria.jpg'], specs: { Type: 'Wall Light', Material: 'Marble' },
    variants: [{ sku: 'FLORIA-TEST', price: 175, currency: 'GBP', in_stock: true, options: {} }],
  }).product;
  product.version = 1;
  const state = { products: [product], config: { markupPct: 0, ebayFeePct: 0, roundTo99: false }, template };
  const category = { categoryId: '116880', categoryName: 'Wall Fixtures', verifiedFromEbay: true,
    requiredAspects: [{ name: 'Brand', values: [] }, { name: 'Type', values: ['Wall Light'] }],
    recommendedAspects: [{ name: 'Material', values: [] }] };
  const downloads = [];
  const blobs = new Map();
  const calls = [];
  const sandbox = {
    $, state, console, Blob,
    sellerExportConfig, buildGroupedEbayCsvs: Core.buildGroupedEbayCsvs,
    groupProductsByTheme: Core.groupProductsByTheme, parseCsvText: Core.parseCsvText,
    templateColumnIndex: Core.templateColumnIndex,
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    renderBrowse: () => {}, loadEmbeddedTemplate: async () => template,
    api: async (path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET' });
      if (path === '/api/ebay/categories/116880') return { category };
      if (path === `/api/products/${product.id}` && init.method === 'PUT') {
        const { edits, version } = JSON.parse(init.body);
        return { product: { ...state.products[0], edits, version: version + 1 } };
      }
      throw new Error(`Unexpected API call ${path}`);
    },
    URL: {
      createObjectURL(blob) { const url = `blob:fixture-${blobs.size + 1}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    document: {
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement(tag) {
        assert.equal(tag, 'a');
        return {
          click() { assert.ok(blobs.has(this.href), 'download blob must exist'); downloads.push({ filename: this.download, blob: blobs.get(this.href) }); },
          remove() {},
        };
      },
    },
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
  };
  function $(id) { return element(id); }
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'app-export-handlers.js' });
  element('categoryProductSelect').value = product.id;
  element('categoryIdInput').value = '116880';
  async function dispatch(id, type) {
    const target = element(id);
    if (type === 'click' && target.disabled) return;
    for (const listener of target.events.get(type) ?? []) await listener({ target, preventDefault() {} });
  }
  return { element, dispatch, downloads, calls, state };
}

test('category form downloads Floria source data even when GBP cannot be priced in USD', async () => {
  const ui = setup();
  await ui.dispatch('categoryTemplateForm', 'submit');
  assert.equal(ui.downloads.length, 1, 'successful submit starts the CSV download');
  const csv = await ui.downloads[0].blob.text();
  const rows = Core.parseCsvText(csv);
  const headers = rows[1];
  const data = rows.filter((row) => row[Core.templateColumnIndex(headers, 'Action')] === 'Add');
  const cell = (name) => data[0][Core.templateColumnIndex(headers, name)];
  assert.equal(data.length, 1);
  assert.equal(cell('CustomLabel'), 'FLORIA-TEST');
  assert.equal(cell('Category'), '116880');
  assert.equal(cell('StartPrice'), '', 'no guessed conversion or zero price');
  assert.equal(cell('C:Material'), 'Marble');
  assert.equal(ui.element('categoryPrepareStatus').className, 'warn');
  assert.match(ui.element('categoryTemplatePreview').innerHTML, /GBP/);
  assert.equal(ui.element('categoryPrepareBtn').disabled, false);
  assert.equal(ui.element('downloadCategoryCsvBtn').disabled, false);
});

test('retry download has one listener across submissions and stale selection disables it', async () => {
  const ui = setup();
  await ui.dispatch('categoryTemplateForm', 'submit');
  await ui.dispatch('categoryTemplateForm', 'submit');
  assert.equal(ui.downloads.length, 2);
  assert.equal(ui.element('downloadCategoryCsvBtn').events.get('click').length, 1);
  await ui.dispatch('downloadCategoryCsvBtn', 'click');
  assert.equal(ui.downloads.length, 3, 'retry creates exactly one download');
  ui.element('categoryIdInput').value = '112581';
  await ui.dispatch('categoryIdInput', 'input');
  assert.equal(ui.element('downloadCategoryCsvBtn').disabled, true);
  assert.equal(ui.element('categoryTemplatePreview').innerHTML, '');
  await ui.dispatch('downloadCategoryCsvBtn', 'click');
  assert.equal(ui.downloads.length, 3, 'stale category output cannot be downloaded');
});
