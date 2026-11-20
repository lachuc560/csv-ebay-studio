// scripts/package-extension.mjs — Đóng gói extension "CSV Studio Crawler" v1.0.0.
// Không build lại từ TypeScript: zip gốc chỉ có bản build (dist/*.js),
// không có source TS, nên script này chỉ COPY thư mục extension-v1.0.0/
// sang dist/extension-v1.0.0/ và nén thành file .zip để cài unpacked / nộp store.
// Không dùng dependency ngoài — chỉ dùng node:fs, node:path, node:child_process.
// Chạy: npm run package   (package.json: "package": "node scripts/package-extension.mjs")

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'extension-v1.0.0');
const outDir = path.join(root, 'dist', 'extension-v1.0.0');
const zipFile = path.join(root, 'dist', 'extension-v1.0.0.zip');

if (!existsSync(src)) {
  console.error(`Không tìm thấy thư mục extension: ${src}`);
  process.exit(1);
}

mkdirSync(path.dirname(outDir), { recursive: true });
rmSync(outDir, { recursive: true, force: true });
rmSync(zipFile, { force: true });
cpSync(src, outDir, { recursive: true });
console.log(`Đã copy ${src} -> ${outDir}`);

// Thử nén bằng lệnh `zip` của hệ thống (có sẵn trên macOS/Linux).
// Nếu không có lệnh zip thì in hướng dẫn nén tay, không lỗi thoát.
try {
  execFileSync('zip', ['-r', '-q', zipFile, 'extension-v1.0.0'], {
    cwd: path.join(root, 'dist'),
    stdio: 'inherit',
  });
  console.log(`Đã nén: ${zipFile}`);
} catch {
  console.log(
    'Không tìm thấy lệnh `zip` trên máy này nên chưa nén được file .zip.\n' +
      'Nén tay: vào thư mục dist/, chọn thư mục extension-v1.0.0/ rồi nén thành\n' +
      'extension-v1.0.0.zip (nén cả thư mục, giữ nguyên manifest.json ở gốc).\n' +
      'Hoặc cài zip rồi chạy lại: npm run package',
  );
}
console.log('Cài thử: mở chrome://extensions, bật Developer mode, "Load unpacked" và chọn dist/extension-v1.0.0/');
