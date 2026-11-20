// scripts/build-extension.mjs — Build extension "CSV Studio Crawler" v1.3.4.
// Nguồn: extension/src/ (bản build v1.0.0 gốc được copy sang làm gốc chỉnh
// sửa — xem docs/soho-bulk.md — KHÔNG sửa thư mục extension-v1.0.0/ gốc).
// Từ v9.2 popup chỉ còn nút "Crawl AI trang này" nên KHÔNG copy
// public/core.js vào dist nữa (không còn code popup nào dùng CsvEbayCore).
// Chạy: npm run build:extension
// Cài thử: chrome://extensions -> Developer mode -> Load unpacked -> extension-v2/

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'extension', 'src');
const out = path.join(root, 'extension-v2');
const version = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid extension version');
const zipFile = path.join(root, 'dist', `extension-v${version}.zip`);

if (!existsSync(src)) {
  console.error(`Không tìm thấy thư mục extension source: ${src}`);
  process.exit(1);
}

mkdirSync(path.dirname(out), { recursive: true });
const resolvedOut = existsSync(out) ? realpathSync(out) : path.resolve(out);
if (path.relative(realpathSync(root), resolvedOut) !== 'extension-v2') throw new Error('Unsafe extension output path');
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
console.log(`Đã copy ${src} -> ${out}`);

// Kiểm tra cú pháp tất cả file JS trong bản build.
for (const f of ['dist/content.js', 'dist/popup.js']) {
  execFileSync('node', ['--check', path.join(out, f)], { stdio: 'inherit' });
}
console.log('Kiểm tra cú pháp OK: content.js, popup.js');

// Windows ships PowerShell's Compress-Archive; Unix uses zip.
mkdirSync(path.join(root, 'dist'), { recursive: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:CSV_STUDIO_BUILD_SOURCE -DestinationPath $env:CSV_STUDIO_BUILD_ZIP -Force'], {
    env: { ...process.env, CSV_STUDIO_BUILD_SOURCE: out, CSV_STUDIO_BUILD_ZIP: zipFile },
    stdio: 'inherit',
  });
} else {
  rmSync(zipFile, { force: true });
  execFileSync('zip', ['-r', '-q', zipFile, 'extension-v2'], {
    cwd: root,
    stdio: 'inherit',
  });
}
console.log(`Đã nén: ${zipFile}`);
console.log('Cài thử: mở chrome://extensions, bật Developer mode, "Load unpacked" và chọn extension-v2/');
