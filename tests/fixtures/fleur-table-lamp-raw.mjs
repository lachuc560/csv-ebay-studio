// Fixture hồi quy v9.5: dữ liệu THẬT của trang Fleur Table Lamp
// https://www.sohohome.com/us/products/fleur-table-lamp
// (đọc trực tiếp ngày 16/11/2026 — giá non-member $315, giá gốc gạch
// ngang $450, member $252; 7 ảnh gallery).
//
// Payload mô phỏng đúng những gì extension v1.3.1 gửi về server
// (extension/src/dist/content.js -> extractAiPage):
// - price top-level = null (buildCsvRecord không có field price ở cấp
//   record) — đây là 1 trong 2 lỗi khiến v9.4 báo "trang không ghi giá".
// - variants: 1 biến thể duy nhất, giá 315, KHÔNG có compareAt
//   (v1.3.1 cắt mất) — giá gốc $450 cũng là compareAt bị mất.
// - specs của reader chỉ có Dimensions / Weight / Assembly required
//   (v1.3.1 chưa có nhãn đèn) — Bulb type / Care instructions... chỉ
//   có trong pageText (panel Details & Dimensions).
//
// Mô tả trong fixture là DIỄN ĐẠT LẠI bằng lời của chúng ta, chỉ giữ
// nguyên 1 câu chất liệu (13 từ) làm dữ kiện thực tế của trang —
// không sao chép nguyên văn đoạn mô tả có bản quyền của Soho Home.
//
// Số 79971888 chỉ xuất hiện trong TÊN FILE ẢNH (vd
// 219687-79971888-listingjpg.jpg), KHÔNG phải SKU — fixture không có
// trường SKU nào, test khẳng định SKU vẫn trống.

export const FLEUR_URL = 'https://www.sohohome.com/us/products/fleur-table-lamp';
export const FLEUR_LISTING_IMAGE = 'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219687-79971888-listingjpg.jpg';
export const FLEUR_TITLE = 'Fleur Table Lamp, US';
export const FLEUR_PRICE = 315;
export const FLEUR_COMPARE_AT = 450;
export const FLEUR_MATERIAL_PHRASE = 'Milky-white glass and lacquered sprayed metals';

// Mô tả diễn đạt lại (mở đầu paraphrase + câu chất liệu gốc 13 từ).
export const FLEUR_DESCRIPTION = 'Fleur lamp takes its cue from the lights in the new Soho House Paris interiors: a modern mushroom lamp with a half-sphere shade on a cylindrical stem, giving off soft warm light. Place it on a console or side table as a stand-alone piece. Milky-white glass and lacquered sprayed metals are formed into an Art Deco-inspired silhouette.';

// 7 ảnh gallery đúng như trang dùng (ảnh lifestyle số 3 tên file là
// "silvo-bedside-table" nhưng trang vẫn dùng làm ảnh Fleur — giữ đúng
// URL trang dùng, không đoán URL khác).
export const FLEUR_IMAGES = [
  FLEUR_LISTING_IMAGE,
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219688-79971888-hoverjpg.jpg',
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1000%2cheight=1000%2ctrim=666%3b0%3b667%3b0/images/original/236397-silvo-bedside-table-870-ef-v2jpg.jpg',
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219689-79971888-detail1jpg.jpg',
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219690-79971888-detail2jpg.jpg',
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219691-79971888-detail3jpg.jpg',
  'https://assets.sohohome.com/cdn-cgi/image/fit=crop%2cformat=auto%2cquality=75%2cwidth=1100%2cheight=1222%2ctrim=388%3b0%3b389%3b0/images/original/219692-79971888-detail4jpg.jpg',
];

// Panel "Details & Dimensions" dạng text phẳng (pageVisibleText):
// intro (mô tả, có từ "shade" trong câu — test khóa việc bộ đào
// panel không được cắt mô tả ở từ "shade"), rồi các cặp nhãn — giá trị.
// "Switch In-line on/off switch" có từ "switch" lặp trong chính giá trị
// của nó (test khóa việc gộp trùng nhãn).
export const FLEUR_PAGE_TEXT = [
  'Fleur Table Lamp',
  'Regular Price $450',
  'Price $315',
  'Details & Dimensions',
  'Fleur lamp takes its cue from the lights in the new Soho House Paris interiors: a modern mushroom lamp with a half-sphere shade on a cylindrical stem, giving off soft warm light. Place it on a console or side table as a stand-alone piece. Milky-white glass and lacquered sprayed metals are formed into an Art Deco-inspired silhouette.',
  'Dimensions',
  'H19.3 x W13.4 x D13.4" / H49 x W34 x D34cm',
  'Shade',
  'H6.7 x W13.4 x D13.4" / H17 x W34 x D34cm',
  'Base',
  'H12.6 x W5.9 x D5.9" / H32 x W15 x D15cm',
  'Weight',
  '13.7 lbs / 6.2 kg',
  'Assembly required',
  'No',
  'Bulb type',
  'E26',
  'Number of bulbs',
  '1',
  'Bulb included',
  'No',
  'Wattage',
  '60W',
  'Light source',
  'LED',
  'Dimmable',
  'No',
  'Switch',
  'In-line on/off switch',
  'Cable length',
  '98.4" / 250cm',
  'Cable colour',
  'Black',
  'Voltage',
  '110-120V',
  'Care instructions',
  'Wipe with a dry cloth. Do not use abrasives or solvents.',
  'Delivery & Returns',
  'Delivery from 4 days',
].join('\n');

// Payload đầy đủ như extension v1.3.1 gửi (reader đọc được mô tả +
// specs cơ bản, giá chỉ ở variant).
export function makeFleurRawA() {
  return {
    url: FLEUR_URL,
    sourceSite: 'sohohome.com',
    sourceProductId: 'fleur-table-lamp',
    brand: 'Soho Home',
    title: FLEUR_TITLE,
    price: null,
    currency: 'USD',
    images: [...FLEUR_IMAGES],
    description: FLEUR_DESCRIPTION,
    specs: {
      Dimensions: 'H19.3 x W13.4 x D13.4" / H49 x W34 x D34cm',
      Weight: '13.7 lbs / 6.2 kg',
      'Assembly required': 'No',
    },
    variants: [{ options: {}, price: FLEUR_PRICE, in_stock: true }],
    pageText: FLEUR_PAGE_TEXT,
  };
}

// Payload xấu nhất: reader không đọc được mô tả/specs (panel accordion
// đóng nên innerText thiếu) — chỉ còn pageText. Server vẫn phải đào
// được hết từ pageText.
export function makeFleurRawB() {
  return {
    url: FLEUR_URL,
    sourceSite: 'sohohome.com',
    sourceProductId: 'fleur-table-lamp',
    brand: 'Soho Home',
    title: FLEUR_TITLE,
    price: null,
    currency: 'USD',
    images: [...FLEUR_IMAGES],
    description: null,
    specs: {},
    variants: [{ options: {}, price: FLEUR_PRICE, in_stock: true }],
    pageText: FLEUR_PAGE_TEXT,
  };
}

// JSON-LD Product như trang trả (chỉ giữ trường cần thiết cho test).
export function makeFleurJsonLd() {
  return {
    '@type': 'Product',
    name: FLEUR_TITLE,
    image: [...FLEUR_IMAGES],
    description: FLEUR_DESCRIPTION,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      price: FLEUR_PRICE,
      availability: 'https://schema.org/InStock',
    },
  };
}
