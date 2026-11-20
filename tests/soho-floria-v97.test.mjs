// tests/soho-floria-v97.test.mjs — Nhãn đèn tường Soho Home + tiền tệ GBP (v9.7).
// Lỗi user báo 18/11/2026 (Floria Wall Light, Calacatta Viola Marble, IP44, UK):
// cào chỉ được 2 ảnh, thiếu Bóng đèn / Kích thước / Chăm sóc, giá hiện
// "$175.00" trong khi trang UK ghi £175. Ảnh đã sửa ở v9.6 (gallery đủ 5);
// còn lại 2 lỗi ở v9.6:
// (1) Panel "Details & Dimensions" của Floria dùng nhãn 'Bulb required'
//     và 'Bulb style' thay cho 'Bulb type' của Fleur, nên cả reader
//     extension, server parseSohoDetailsText và danh sách "Đã cào được"
//     đều bỏ qua bóng đèn. Trang thật còn có 'Bulb(s) included',
//     'Electrician required', 'IP Rating', 'Bathroom safe' — cũng chưa
//     có trong danh sách nhãn. Nhãn đã kiểm lại từ trang Soho Home thật
//     ngày 18/11/2026 (kết quả tìm kiếm: "Bulb required: 1/G9/5W Maximum",
//     "Bulb style: Tala 4W G9 LED", "Bulb(s) included: No",
//     "Electrician required: Yes", "IP Rating: IP44", "Wattage: 5W Max").
// (2) Popup + web "Đã cào được" hard-code ký hiệu '$' nên giá £175 của
//     trang UK hiện thành $175.00. Giá trị số KHÔNG đổi (StartPrice vẫn
//     là số trên trang, team chốt giá bán USD riêng); chỉ sửa ký hiệu
//     hiển thị theo currency sản phẩm mang về.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSohoDetailsText } from '../server/ai.mjs';
import { crawledSummaryItems } from '../public/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const contentJs = readFileSync(path.join(repo, 'extension/src/dist/content.js'), 'utf8');

// Panel Floria thật (đã làm phẳng như pageText extension gửi).
const FLORIA_PANEL = [
  'Details & Dimensions',
  'The Floria wall light draws inspiration from the interiors of DUMBO.',
  'Dimensions H13.6 x W16.3 x D16.3cm',
  'Bulb required 1/G9/5W Maximum',
  'Bulb style Tala 4W G9 LED',
  'Bulb(s) included No',
  'Wattage 5W Max',
  'Marble type Calacatta Viola',
  'Care instructions Wipe clean with a soft, dry cloth',
  'Electrician required Yes',
  'IP Rating IP44',
  'Bathroom safe Yes',
  'Assembly required Yes',
].join(' ');

test('v9.7: parseSohoDetailsText nhận nhãn đèn tường Floria', () => {
  const { specs } = parseSohoDetailsText(FLORIA_PANEL);
  assert.equal(specs['Dimensions'], 'H13.6 x W16.3 x D16.3cm');
  assert.equal(specs['Bulb required'], '1/G9/5W Maximum');
  assert.equal(specs['Bulb style'], 'Tala 4W G9 LED');
  assert.equal(specs['Bulb(s) included'], 'No');
  assert.equal(specs.Wattage, '5W Max');
  assert.equal(specs['Marble type'], 'Calacatta Viola');
  assert.equal(specs['Care instructions'], 'Wipe clean with a soft, dry cloth');
  assert.equal(specs['Electrician required'], 'Yes');
  assert.equal(specs['IP Rating'], 'IP44');
  assert.equal(specs['Bathroom safe'], 'Yes');
});

test('v9.7: reader extension dùng cùng bộ nhãn đèn tường', () => {
  for (const label of ['Bulb required', 'Bulb style', 'Bulb(s) included', 'Electrician required', 'IP Rating', 'Bathroom safe']) {
    assert.ok(contentJs.includes(`"${label}"`), `content.js thiếu nhãn ${label}`);
  }
});

test('v9.7: "Đã cào được" hiện đủ bóng đèn + giá £ cho Floria UK', () => {
  const product = {
    title: 'Floria Wall Light, Calacatta Viola Marble, IP44, UK',
    price: 175,
    currency: 'GBP',
    images: ['https://assets.sohohome.com/a.jpg'],
    description: 'The Floria wall light draws inspiration from the interiors of DUMBO.',
    specs: {
      Dimensions: 'H13.6 x W16.3 x D16.3cm',
      'Bulb required': '1/G9/5W Maximum',
      'Bulb style': 'Tala 4W G9 LED',
      Wattage: '5W Max',
      'Care instructions': 'Wipe clean with a soft, dry cloth',
    },
    variants: [{ options: {}, price: 175, currency: 'GBP', in_stock: true }],
  };
  const items = crawledSummaryItems(product, {});
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
  assert.ok(byLabel['Giá'].startsWith('£175.00'), `Giá phải bắt đầu bằng £175.00, thực tế: ${byLabel['Giá']}`);
  assert.ok(!byLabel['Giá'].startsWith('$'), 'Giá Floria UK không được hiện $');
  assert.equal(byLabel['Bóng đèn'], '1/G9/5W Maximum — Tala 4W G9 LED — 5W Max');
  assert.equal(byLabel['Kích thước'], 'H13.6 x W16.3 x D16.3cm');
  assert.equal(byLabel['Chăm sóc'], 'Wipe clean with a soft, dry cloth');
});

test('v9.7: đèn bàn Fleur cũ vẫn hiện bóng như trước (không hồi quy)', () => {
  const product = {
    title: 'Fleur Table Lamp',
    price: 315,
    currency: 'USD',
    images: [],
    description: 'Milky-white glass and lacquered sprayed metals.',
    specs: { 'Bulb type': 'E26', Wattage: '60W' },
    variants: [],
  };
  const items = crawledSummaryItems(product, {});
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
  assert.ok(byLabel['Giá'].startsWith('$315.00'), `Giá phải bắt đầu bằng $315.00, thực tế: ${byLabel['Giá']}`);
  assert.equal(byLabel['Bóng đèn'], 'E26 — 60W');
});
