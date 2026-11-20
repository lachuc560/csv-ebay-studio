// Read-only R2 HeadBucket diagnostic. No uploads, object listing, or secret output.
// https://developers.cloudflare.com/r2/api/s3/api/
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { CloudflareImagesRuntime } from '../server/cloudflare-images.mjs';

const env = {};
for (const line of (await readFile(process.argv[2] ?? '.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const runtime = new CloudflareImagesRuntime(env);
if (!runtime.isConfigured()) {
  console.log(JSON.stringify({ service: 'r2', configured: false }));
  process.exitCode = 1;
} else {
  const cfg = runtime.getEffectiveConfig();
  // Only send these credentials to the configured Cloudflare account endpoint.
  if (!/^[a-f0-9]{32}$/i.test(cfg.accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) {
    console.log(JSON.stringify({ service: 'r2', configured: true, error: 'invalid_account_or_bucket_format' }));
    process.exitCode = 1;
  } else {
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const target = new URL(`/${cfg.bucket}`, runtime.r2Endpoint());
    const payloadHash = sha('');
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const canonical = ['HEAD', target.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/auto/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
    const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha(canonical)}`).toString('hex');
    try {
      const response = await fetch(target, {
        method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
        },
      });
      console.log(JSON.stringify({ service: 'r2', configured: true, status: response.status, bucketAccess: response.ok, uploadTested: false }));
      if (!response.ok) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ service: 'r2', configured: true, error: error?.cause?.code ?? error?.name ?? 'request_failed' }));
      process.exitCode = 1;
    }
  }
}
