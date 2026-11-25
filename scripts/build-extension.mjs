// scripts/build-extension.mjs — Build extension "CSV Studio Crawler" v1.3.4.
// Nguồn: extension/src/ (bản build v1.0.0 gốc được copy sang làm gốc chỉnh
// sửa — xem docs/soho-bulk.md — KHÔNG sửa thư mục extension-v1.0.0/ gốc).
// Từ v9.2 popup chỉ còn nút "Crawl AI trang này" nên KHÔNG copy
// public/core.js vào dist nữa (không còn code popup nào dùng CsvEbayCore).
// Chạy: npm run build:extension
// Cài thử: chrome://extensions -> Developer mode -> Load unpacked -> extension-v2/

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
for (const f of ['dist/content.js', 'dist/popup.js', 'dist/background.js']) {
  execFileSync('node', ['--check', path.join(out, f)], { stdio: 'inherit' });
}
console.log('Kiểm tra cú pháp OK: content.js, popup.js, background.js');

// Windows ships PowerShell's Compress-Archive; Unix uses zip.
// manifest.json phải nằm ở GỐC file ZIP (Chrome Web Store yêu cầu) — nén
// nội dung bên trong extension-v2/, không nén cả thư mục.
mkdirSync(path.join(root, 'dist'), { recursive: true });
rmSync(zipFile, { force: true });
if (process.platform === 'win32') {
  // Ưu tiên tar.exe (bsdtar, có sẵn từ Windows 10): đường dẫn trong ZIP dùng
  // '/' đúng chuẩn. Compress-Archive của PowerShell 5.1 ghi 'dist\content.js'
  // (dấu '\'), giải nén ngoài Windows bị lỗi — chỉ dùng làm dự phòng.
  try {
    execFileSync('tar.exe', ['-a', '-c', '-f', zipFile, '-C', out, ...readdirSync(out)], { stdio: 'inherit' });
  } catch {
    rmSync(zipFile, { force: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; Compress-Archive -Path (Join-Path -Path $env:CSV_STUDIO_BUILD_SOURCE -ChildPath "*") -DestinationPath $env:CSV_STUDIO_BUILD_ZIP -Force'], {
      env: { ...process.env, CSV_STUDIO_BUILD_SOURCE: out, CSV_STUDIO_BUILD_ZIP: zipFile },
      stdio: 'inherit',
    });
  }
} else {
  execFileSync('zip', ['-r', '-q', zipFile, '.'], {
    cwd: out,
    stdio: 'inherit',
  });
}
// Compress-Archive có thể lỗi mà powershell vẫn thoát 0 — kiểm tra file thật.
if (!existsSync(zipFile)) throw new Error(`Không tạo được file ZIP: ${zipFile}`);
console.log(`Đã nén: ${zipFile}`);
console.log('Cài thử: mở chrome://extensions, bật Developer mode, "Load unpacked" và chọn extension-v2/');
