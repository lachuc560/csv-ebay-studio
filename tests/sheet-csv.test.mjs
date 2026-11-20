// tests/sheet-csv.test.mjs — parseSheetCsv (đọc file CSV xuất từ sheet).
// Trước đây file này là google-sheet.test.mjs, test cả parseGoogleSheetUrl
// và fetchGoogleSheetCsv; từ v9.2 luồng dán link Google Sheet đã bỏ nên
// 2 hàm đó đã xoá khỏi core.js, chỉ còn test parseSheetCsv ở đây — hàm này
// vẫn dùng trong core.js (autoSheetToCsv) và trong test khác để dựng
// fixture từ dữ liệu sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetCsv } from '../public/core.js';

// CSV dạng sheet Soho Home thật (cột theo ảnh chụp Sabo_Lucky_Rate 9):
// A TYPE, E NGÁCH BRAND, F TITLE, G DESCRIPTION, H SIZE, I EBAY,
// J Site chính, L COST. Dòng 2 link chỉ ở cột EBAY, dòng 3 link chỉ ở
// cột Site chính, dòng 4 trùng link dòng 2, dòng 5 trống.
const SOHO_CSV =
  'TYPE,SOLD,ACCOUNT,FOLDER,NGÁCH BRAND,TITLE,DESCRIPTION,SIZE,EBAY,Site chính MIN - MAX 100$-1000$,COST,QTY\n' +
  ',,T1106LKIM02,,SohoHome,Soho Home Dax Chair,"<div>Chair</div>",,https://www.sohohome.com/us/products/dax-chair,,$395.00,1\n' +
  'Gối,,,,"SohoHome",Soho Home Throw Pillow,"<div>Pillow</div>",18 x 18 in,,https://www.sohohome.com/us/products/throw-pillow,$170.00,1\n' +
  ',,T1106LKIM02,,SohoHome,Soho Home Dax Chair dup,"<div>Chair</div>",,https://www.sohohome.com/us/products/dax-chair,,$395.00,1\n' +
  ',,,,,,,,,,,\n';

test('parseSheetCsv: link ở cả cột EBAY và cột Site chính, bỏ trống/trùng, giữ TYPE/NGÁCH/COST', () => {
  const { items, invalid } = parseSheetCsv(SOHO_CSV);
  assert.equal(items.length, 2, 'dòng trùng và dòng trống bị bỏ');
  assert.deepEqual(invalid, []);
  // Dòng 2 (dòng đầu dữ liệu): link ở cột EBAY.
  assert.equal(items[0].url, 'https://www.sohohome.com/us/products/dax-chair');
  assert.equal(items[0].type, null, 'TYPE trống');
  assert.equal(items[0].brand, 'SohoHome', 'NGÁCH BRAND = SohoHome');
  assert.equal(items[0].title, 'Soho Home Dax Chair');
  assert.equal(items[0].title_hint, 'Soho Home Dax Chair');
  assert.equal(items[0].cost, 395);
  assert.equal(items[0].cost_hint, 395);
  assert.equal(items[0].description, '<div>Chair</div>');
  assert.equal(items[0].source_row, 2);
  // Dòng 3: link chỉ ở cột Site chính, TYPE = Gối.
  assert.equal(items[1].url, 'https://www.sohohome.com/us/products/throw-pillow');
  assert.equal(items[1].type, 'Gối');
  assert.equal(items[1].theme, 'Gối');
  assert.equal(items[1].size, '18 x 18 in');
  assert.equal(items[1].cost, 170);
  assert.equal(items[1].source_row, 3);
});
