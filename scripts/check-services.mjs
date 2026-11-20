// Read-only diagnostics. Never print secret values or provider response bodies.
import { readFile } from 'node:fs/promises';
import { EbayTaxonomyRuntime } from '../server/ebay-taxonomy.mjs';
import { CloudflareImagesRuntime } from '../server/cloudflare-images.mjs';
import { callGemini, DEFAULT_AI_MODELS } from '../server/ai-providers.mjs';

const configFile = process.argv[2] ?? '.env';
const flags = new Set(process.argv.slice(3));
const env = {};
for (const line of (await readFile(configFile, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const results = await Promise.allSettled([
  (async () => {
    if (env.AI_PROVIDER !== 'gemini' && !flags.has('--gemini')) return { service: 'gemini', skipped: true, reason: 'provider_not_gemini' };
    if (!env.AI_API_KEY) return { service: 'gemini', configured: false };
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': env.AI_API_KEY }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { service: 'gemini', status: res.status };
    const json = await res.json();
    const models = (json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((name) => /flash/.test(name) && !/tts|audio|image|live|robotics|computer/.test(name));
    const result = { service: 'gemini', status: res.status, availableTextModels: models, morePages: Boolean(json.nextPageToken) };
    if (flags.has('--generate')) {
      let resolvedModel;
      try {
        const output = await callGemini({
          model: env.AI_PROVIDER === 'gemini' && env.AI_MODEL ? env.AI_MODEL : DEFAULT_AI_MODELS.gemini,
          apiKey: env.AI_API_KEY,
          system: 'Extract only facts in the product text. Return JSON with title, color and dimensions. Missing dimensions must be null.',
          user: 'Tilney Square Cushion, Green. Price $280 USD. Material: Cotton. No dimensions provided.',
          onModelResolved: (model) => { resolvedModel = model; },
        });
        result.generation = { ok: true, model: resolvedModel, title: String(output.title ?? '').slice(0, 100), color: String(output.color ?? '').slice(0, 40), preservesMissingDimensions: output.dimensions === null };
      } catch (error) {
        result.generation = { ok: false, httpStatus: Number(String(error?.message).match(/HTTP (\d{3})/)?.[1]) || null, timeout: /timeout/i.test(error?.message ?? '') };
      }
    }
    return result;
  })(),
  (async () => {
    const runtime = new EbayTaxonomyRuntime(env);
    const requests = [];
    runtime.fetchFn = async (url, init) => {
      const target = new URL(url);
      if (!['api.ebay.com', 'api.sandbox.ebay.com'].includes(target.hostname)) throw new Error('Unexpected service destination');
      const response = await fetch(url, init);
      const entry = { endpoint: target.pathname, status: response.status };
      if (!response.ok) {
        const body = await response.clone().json().catch(() => ({}));
        entry.errorIds = (body.errors ?? []).map((error) => Number(error.errorId)).filter(Number.isFinite);
      }
      requests.push(entry);
      return response;
    };
    if (!runtime.getStatus().configured) return { service: 'ebay', configured: false };
    try {
      const categoryTreeId = await runtime.getDefaultCategoryTreeId();
      const result = { service: 'ebay', connected: true, categoryTreeId, requests };
      if (flags.has('--category')) {
        const category = await runtime.getCategoryDetails('20563');
        result.category = { id: category.categoryId, name: category.categoryName, requiredAspects: category.requiredAspects.map((a) => a.name), recommendedCount: category.recommendedAspects.length };
      }
      return result;
    } catch (error) { return { service: 'ebay', connected: false, code: error.code ?? 'request_failed', requests }; }
  })(),
]);
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  console.log(JSON.stringify(result.status === 'fulfilled' ? result.value : { service: i === 0 ? 'gemini' : 'ebay', error: result.reason?.cause?.code ?? result.reason?.name ?? 'request_failed' }));
}
console.log(JSON.stringify({ service: 'r2', configured: new CloudflareImagesRuntime(env).getStatus().configured, connectivityTested: false }));
