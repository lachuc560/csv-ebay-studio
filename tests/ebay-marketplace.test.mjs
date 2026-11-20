import test from 'node:test';
import assert from 'node:assert/strict';
import { EbayTaxonomyRuntime } from '../server/ebay-taxonomy.mjs';

test('real Taxonomy request uses EBAY_US and normalizes legacy hyphenated configuration', async () => {
  for (const legacy of [null, 'EBAY-US']) {
    const runtime = new EbayTaxonomyRuntime({ EBAY_APP_ID: 'fake-app', EBAY_CERT_ID: 'fake-secret', ...(legacy ? { EBAY_MARKETPLACE_ID: legacy } : {}) });
    runtime.fetchFn = async (url) => {
      if (url.includes('/identity/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token', expires_in: 7200 }) };
      assert.equal(new URL(url).searchParams.get('marketplace_id'), 'EBAY_US');
      return { ok: true, status: 200, json: async () => ({ categoryTreeId: '0' }) };
    };
    assert.equal(await runtime.getDefaultCategoryTreeId(), '0');
    assert.equal(runtime.getStatus().marketplace, 'EBAY_US');
    runtime.setMemoryConfig({ marketplaceId: 'ebay-gb' });
    assert.equal(runtime.getStatus().marketplace, 'EBAY_GB');
  }
});
