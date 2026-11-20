import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseEbayTemplate, parseCsvText, normalizeRecord, buildEbayTemplateCsv,
  validateEbayTemplateProducts, getAspectValue, parseSohoWeight, templateColumnIndex,
} from '../public/core.js';

const template = parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
const config = { markupPct: 0, ebayFeePct: 0, roundTo99: false };
const lamp = () => normalizeRecord({
  source_site: 'sohohome.com', source_product_id: 'remi-fixture',
  title: 'Remi Stone Table Lamp, Cream, US', brand: 'Soho Home', currency: 'USD', price: 350,
  description: 'A travertine lamp with a natural linen shade.', images: ['https://images.example/remi.jpg'],
  specs: { Dimensions: 'H53.7 x W35 x D35cm / H20.9 x W13.8 x D13.8"', Weight: '6.7kg / 14.8lbs',
    Material: 'Stone', Voltage: '110-120V', Dimmable: 'Yes', 'Bulb style': 'Tala 6W Globe LED',
    'Lighting Certification US': 'UL', 'Care instructions': 'Wipe with a dry cloth.',
    'Bulb required': '1/E26/6W Maximum', Wattage: '6W Max' },
  variants: [{ sku: '74525624', price: 350, in_stock: true, options: { Color: 'Cream', Height: 'Tall' } }],
}).product;
const category = {
  categoryId: '112581', categoryName: 'Lamps', verifiedFromEbay: true,
  requiredAspects: [{ name: 'Brand', values: ['Soho Home'] }, { name: 'Type', values: ['Table Lamp'] }],
  recommendedAspects: ['Color', 'Material', 'Voltage', 'Item Height', 'Item Width', 'Item Length', 'Item Weight',
    'Features', 'Lighting Technology', 'Labels & Certifications', 'Power Consumption', 'Bulb Shape Code']
    .map((name) => ({ name, values: [], aspectConstraint: { aspectMode: 'FREE_TEXT' } })),
};
function read(csv) {
  const rows = parseCsvText(csv);
  const headers = rows[1];
  const data = rows.find((row) => row[0] === 'Add');
  return { rows, headers, data, value: (name) => data[headers.findIndex((h) => h.replace(/^\*/, '') === name)] };
}

test('resolved lamp CSV uses only lamp aspects and preserves real source precision', () => {
  const { headers, value } = read(buildEbayTemplateCsv([lamp()], template, config, { resolvedCategory: category }));
  const names = headers.filter((h) => /^\*?C:/.test(h)).map((h) => h.replace(/^\*?C:/, ''));
  assert.deepEqual(new Set(names), new Set([...category.requiredAspects, ...category.recommendedAspects].map((a) => a.name)));
  assert.equal(names.includes('Fill Material'), false);
  assert.equal(names.includes('Care Instructions'), false);
  assert.equal(names.includes('Height'), false, 'unrelated source options do not add unsupported category columns');
  assert.equal(value('C:Type'), 'Table Lamp');
  assert.equal(value('C:Color'), 'Cream');
  assert.equal(value('C:Item Height'), '20.9 in');
  assert.equal(value('C:Item Width'), '13.8 in');
  assert.equal(value('C:Item Weight'), '14.8 lb');
  assert.equal(value('C:Voltage'), '110-120V');
  assert.equal(value('C:Features'), 'Dimmable');
  assert.equal(value('C:Lighting Technology'), 'LED');
  assert.equal(value('C:Labels & Certifications'), 'UL');
  assert.equal(value('C:Power Consumption'), '', 'maximum bulb wattage is not actual power consumption');
  assert.equal(value('C:Bulb Shape Code'), '', 'E26 socket code is not inferred as bulb shape');
});

test('fresh same-category metadata replaces stale required rules and values in Info rows', () => {
  const resolved = { categoryId: '20563', requiredAspects: [{ name: 'Material', values: ['Stone'] }], recommendedAspects: [] };
  const csv = buildEbayTemplateCsv([lamp()], template, config, { resolvedCategory: resolved });
  assert.ok(csv.includes('The required aspects are Material'));
  assert.ok(!csv.includes('The required aspects are Type; Brand'));
  assert.ok(!csv.includes('Back Cushion'));
  assert.deepEqual(read(csv).headers.filter((h) => /^\*?C:/.test(h)).map((h) => h.replace(/^\*/, '')), ['C:Material']);
  assert.ok(template.infoRows.some((row) => row.some((cell) => cell.includes('Back Cushion'))), 'source template remains intact');
});

test('CSV value hints are bounded previews without truncating runtime constraints', () => {
  const values = Array.from({ length: 25 }, (_, i) => `Pattern ${i + 1}`);
  const p = lamp();
  p.attributes.Pattern = 'Pattern 25';
  const resolved = { categoryId: '112581', requiredAspects: [], recommendedAspects: [
    { name: 'Pattern', values, aspectConstraint: { aspectMode: 'SELECTION_ONLY' } },
    { name: 'Finish', values: ['x'.repeat(33000), 'Matte'] },
  ] };
  const csv = buildEbayTemplateCsv([p], template, config, { resolvedCategory: resolved });
  const info = read(csv).rows.filter((row) => row[0] === 'Info').flat();
  assert.ok(info.every((cell) => cell.length < 1200));
  assert.ok(csv.includes('13 additional value(s) omitted'));
  assert.ok(csv.includes('2 additional value(s) omitted'));
  assert.equal(values.length, 25);
  assert.equal(resolved.recommendedAspects[1].values[0].length, 33000);
  const validation = validateEbayTemplateProducts([p], template, config, resolved, csv);
  assert.ok(!validation.validationIssues.some((issue) => issue.field === 'C:Pattern'));
  assert.equal(parseEbayTemplate(csv).recommendedValues.Pattern, undefined, 'shortened hint is not parsed as a complete values list');
});

test('lamp aliases respect explicit facts and do not invent dimmer, LED or certification', () => {
  const p = lamp();
  p.attributes.Features = 'Portable';
  p.specs['Lighting Technology'] = 'Incandescent';
  assert.equal(getAspectValue(p, 'Features'), 'Portable');
  assert.equal(getAspectValue(p, 'Lighting Technology'), 'Incandescent');
  p.attributes.Features = null;
  p.specs.Dimmable = 'No';
  p.specs['Lighting Technology'] = null;
  p.specs['Bulb style'] = 'LED-compatible fixture; bulb unspecified';
  delete p.specs['Lighting Certification US'];
  p.specs['Electrician required'] = 'No Lighting Certification US: UL';
  assert.equal(getAspectValue(p, 'Features'), null);
  assert.equal(getAspectValue(p, 'Lighting Technology'), null);
  assert.equal(getAspectValue(p, 'Labels & Certifications'), null);
});

test('negative LED descriptions do not become positive lighting technology claims', () => {
  const p = lamp();
  for (const value of ['Non-LED', 'Not LED', 'No LED', 'Without LED', 'Not compatible with LED']) {
    p.specs['Bulb style'] = value;
    assert.equal(getAspectValue(p, 'Lighting Technology'), null, value);
  }
  p.specs['Lighting Technology'] = 'Incandescent';
  assert.equal(getAspectValue(p, 'Lighting Technology'), 'Incandescent', 'explicit source field still wins');
});

test('decimal-comma weights preserve numeric value rather than matching the fractional tail', () => {
  assert.equal(parseSohoWeight('6,7kg / 14,8lbs'), '14.8 lb');
  assert.equal(parseSohoWeight('14,8 lb'), '14.8 lb');
  assert.equal(parseSohoWeight('14.8 lbs'), '14.8 lb');
  assert.equal(parseSohoWeight('14.8.2lbs'), null);
  assert.equal(parseSohoWeight('-14.8lbs'), null);
});

test('category aspect casing does not duplicate columns or override approved source values', () => {
  const p = lamp();
  p.edits = { aiSpecifics: { Color: 'Approved Cream' } };
  const resolved = { categoryId: '112581', requiredAspects: [{ name: 'color', values: [] }], recommendedAspects: [] };
  const csv = buildEbayTemplateCsv([p], template, config, { resolvedCategory: resolved });
  const { headers, data } = read(csv);
  assert.equal(headers.filter((h) => h.replace(/^\*/, '').toLowerCase() === 'c:color').length, 1);
  assert.equal(data[templateColumnIndex(headers, 'C:color')], 'Approved Cream');
  const review = validateEbayTemplateProducts([p], template, config, resolved, csv);
  assert.ok(!review.validationIssues.some((issue) => issue.field.toLowerCase() === 'c:color'));
});
