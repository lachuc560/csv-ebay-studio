import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Core from '../public/core.js';

test('saved category ID without schema asks for a fresh lookup instead of silently dropping all specifics', () => {
  const template = Core.parseEbayTemplate(readFileSync(new URL('../public/templates/ebay-20563.csv', import.meta.url), 'utf8'));
  const p = Core.normalizeRecord({ source_site: 'fixture.example', source_product_id: 'lamp',
    title: 'Table Lamp', brand: 'Fixture', price: 100, currency: 'USD', in_stock: true }).product;
  p.edits = { ebayCategoryId: '112581', ebayCategoryName: 'Lamps' };
  const resolved = Core.resolvedCategoryFromEdits(p.edits);
  assert.equal(resolved.aspectSchemaAvailable, false);
  const result = Core.buildGroupedEbayCsvs([p], template);
  assert.equal(result.files.length, 0);
  assert.match(result.skipped[0].reason, /Tra Category ID/);
  assert.throws(() => Core.buildEbayTemplateCsv([p], template, {}, { resolvedCategory: resolved }), /Tra Category ID/);
  const emptyButKnown = Core.resolvedCategoryFromEdits({ ...p.edits, ebayRequiredAspects: [], ebayRecommendedAspects: [] });
  assert.notEqual(emptyButKnown.aspectSchemaAvailable, false, 'a response with explicit empty arrays remains distinct from missing metadata');
});
