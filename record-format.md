# Định dạng record JSON — đầu vào của `/api/ingest/records`

Một **record** là một sản phẩm crawl được từ một site, gửi lên tool qua
`POST /api/ingest/records` với `Authorization: Bearer csvk_...`, body
`{ "records": [record, ...] }`. Server chuẩn hoá record bằng
`normalizeRecord()` trong `public/core.js` rồi gộp trùng theo
`source_site + source_product_id` (xem `parseImport()` / `mergeProducts()`).

Hai nguồn gửi record vào cùng một kho, cùng một shape này:

- **Extension "CSV Studio Crawler" v1.0.0** — đọc trang thật trong Chrome
  của seller, gửi 1 record mỗi lần bấm. Xem `docs/extension-audit.md`.
- **Crawl tự động (`scripts/push-crawl.mjs`)** — đẩy hàng loạt file JSON.

> Không có UPC và số lượng tồn trong dữ liệu Muse cũ (cả 4 site, xem
> HANDOFF mục 5): hai trường này luôn có thể là `null` và tool không được
> đòi chúng bắt buộc.

## 1. Ví dụ 1 — OGL Move, đúng shape extension v1.0.0 gửi

Ví dụ này lấy từ test `extension v1.0.0 record` trong
`tests/core.test.mjs` — tức là shape mà `dist/content.js`
(`buildCsvRecord()`) thực sự tạo ra. Lưu ý:

- `source_site` là **hostname** (`oglmove.com`), server tự map về slug
  `ogl-move` bằng `normalizeSite()`.
- **Không có `price` ở cấp record** — giá nằm ở từng variant.
- Tuỳ chọn thứ ba `Height` nằm trong `extra_options` của variant, và tên
  tuỳ chọn nằm trong `options` cấp record.

```json
{
  "source_site": "oglmove.com",
  "source_url": "https://oglmove.com/products/flowy-midi-dress",
  "source_product_id": "123456789",
  "crawled_at": "2026-11-13T00:00:00.000Z",
  "brand": "OGL Move",
  "title": "Flowy Midi Dress",
  "breadcrumb": ["Women", "Dresses"],
  "department": "Women",
  "description_text": "Soft dress",
  "attributes": {
    "material": "100% Rayon",
    "fit": "Regular",
    "care": null,
    "country_of_origin": null,
    "dimensions": null
  },
  "images": ["https://cdn.shopify.com/1.jpg"],
  "options": ["Size", "Color", "Height"],
  "variants": [
    {
      "sku": "SKU-1",
      "size": "S",
      "color": "Black",
      "extra_options": { "Height": "Regular" },
      "price": 89,
      "compare_at_price": 110,
      "currency": "USD",
      "in_stock": true,
      "stock_qty": null,
      "upc": "123456789012",
      "image": null
    },
    {
      "sku": "SKU-2",
      "size": "M",
      "color": "Black",
      "extra_options": { "Height": "Regular" },
      "price": 95,
      "compare_at_price": null,
      "currency": "USD",
      "in_stock": true,
      "stock_qty": null,
      "upc": null,
      "image": null
    }
  ],
  "flags": { "price_estimated": false },
  "crawl_truncated": false
}
```

Server chuẩn hoá record trên thành product: `source_site: "ogl-move"`,
`price: 89` (giá variant còn hàng thấp nhất), `currency: "USD"`,
`option_names: ["Size", "Color", "Height"]`,
`variants[0].options.Height: "Regular"`, `upc: "123456789012"` (UPC của
variant đầu tiên có UPC), `price_estimated: false`, `truncated: false`.

## 2. Ví dụ 2 — push-crawl (crawl tự động)

Dạng này **được phép có `price` ở cấp record** (dữ liệu Muse cũ có giá
cấp record) và dùng dạng `options` dạng object trong variant. Server ưu
tiên `price` cấp record nếu có và hợp lệ; nếu không có, lấy giá variant
còn hàng thấp nhất như ví dụ 1.

```json
{
  "source_site": "azazie",
  "source_url": "https://www.azazie.com/products/dress-a1",
  "source_product_id": "A1",
  "crawled_at": "2026-11-07T00:00:00.000Z",
  "brand": "Azazie",
  "title": "Azazie Bridesmaid Dress",
  "breadcrumb": ["Women", "Dresses"],
  "department": "Women",
  "description_text": "Chiffon bridesmaid dress.",
  "attributes": {
    "material": "100% Polyester",
    "fit": null,
    "care": "Dry clean only",
    "country_of_origin": null,
    "dimensions": null
  },
  "images": ["https://cdn.azazie.com/1.jpg"],
  "options": ["Size", "Color"],
  "price": 89,
  "currency": "USD",
  "variants": [
    {
      "options": { "Size": "US 4", "Color": "Black" },
      "price": 89,
      "compare_at_price": null,
      "currency": "USD",
      "in_stock": true,
      "stock_qty": null,
      "sku": "A1-S-BLK",
      "upc": null,
      "image": null
    },
    {
      "options": { "Size": "US 6", "Color": "Black" },
      "price": 89,
      "compare_at_price": null,
      "currency": "USD",
      "in_stock": false,
      "stock_qty": null,
      "sku": "A1-M-BLK",
      "upc": null,
      "image": null
    }
  ],
  "flags": { "price_estimated": true },
  "crawl_truncated": false
}
```

Vì `source_site` là Azazie, `core.js` luôn gắn cờ `price_estimated: true`
cho product này (cùng với Amazon), dù `flags.price_estimated` có là gì.

## 3. Bảng từng trường

### Cấp record

| Trường | Bắt buộc | Kiểu / ghi chú |
|---|---|---|
| `source_site` | Có | Chuỗi. Hostname (`oglmove.com`) hoặc tên site (`OGL Move`, `azazie`). Server chuẩn hoá bằng `normalizeSite()`. Thiếu → lỗi `missing source_site`. |
| `source_product_id` | Có | Chuỗi, mã của site (handle Shopify, ASIN, item ID…). Cùng `source_site` tạo mã product `p_<hash>`. Thiếu → lỗi `missing source_product_id`. |
| `source_url` | Không | URL trang sản phẩm đã crawl (còn gọi là `url`). |
| `crawled_at` | Không | ISO 8601. Thiếu thì server lấy thời điểm nhận. |
| `brand` | Không | Chuỗi hoặc `null`. |
| `title` | Có | Chuỗi, không rỗng. Server cắt tối đa 80 ký tự (`MAX_TITLE_LENGTH`). Thiếu → lỗi `missing title`. |
| `breadcrumb` | Không | Mảng chuỗi, vd `["Women", "Dresses"]`. |
| `department` | Không | `"Women"` / `"Men"` / `null`. Extension tự suy ra từ site/breadcrumb/title. |
| `description_text` | Không | Mô tả dạng text (còn gọi là `description`). |
| `attributes` | Không | Object với các khoá cố định: `material`, `fit`, `care`, `country_of_origin`, `dimensions`. Giá trị chuỗi hoặc `null`. Extension lấy từ item specifics của trang, `material` có thể suy ra từ chuỗi `%` trong mô tả. |
| `images` | Không | Mảng URL ảnh (tối đa 24 ảnh được giữ, `MAX_IMAGES`). Extension **throw lỗi và không gửi record** nếu không lấy được ảnh nào. |
| `options` | Không | Mảng tên tuỳ chọn, vd `["Size", "Color", "Height"]`. Tên nào chưa xuất hiện trong variant vẫn được thêm vào `option_names` của product. |
| `price` | Không | Số, giá cấp record. Extension v1.0.0 **không gửi** trường này; push-crawl có thể gửi. Nếu thiếu/không hợp lệ, server lấy giá variant còn hàng thấp nhất. |
| `currency` | Không | Mã tiền tệ, vd `USD`. Thiếu thì lấy từ variant đầu tiên có currency, mặc định `USD`. **Cảnh báo:** nếu là `VND` (AliExpress từ IP Việt Nam), tool chặn xuất — seller phải đổi tiền tệ trang sang USD rồi crawl lại. |
| `variants` | Không* | Mảng variant (xem dưới). *Thiếu/rỗng thì server tạo một variant mặc định từ giá/ảnh chung (sản phẩm đơn), `price` có thể là `null` — server phải chặn xuất khi `price` là `null`. |
| `flags.price_estimated` | Không | Boolean. `true` khi giá các biến thể chỉ là giá của biến thể đang chọn (Amazon, Azazie / fallback generic). Server còn tự gắn cờ cho Amazon và Azazie. |
| `crawl_truncated` | Không | Boolean (còn gọi là `truncated`). `true` khi crawl chưa đọc hết lựa chọn (AliExpress/Salesforce chạm giới hạn lần đọc) hoặc khi số variant còn hàng vượt 250 (`MAX_VARIANTS`). |
| `category` | Không | Danh mục eBay đã chốt (nếu có). |
| `product_type` | Không | Loại sản phẩm nội bộ (nếu có). |
| `extra_options` | Không | Object tuỳ chọn thêm ở cấp record (hiếm dùng; tuỳ chọn thêm thường nằm ở từng variant). |
| `specs` | Không | Object thông số thêm (nếu có). |
| `crawl_errors` / `errors` | Không | Mảng lỗi crawl đi kèm record (xem mục 4). |

### Từng variant trong `variants`

Một variant có thể viết theo **hai dạng**, server đều nhận
(`normalizeVariant()` trong `core.js`):

- **Dạng extension** (rút gọn): `size`, `color`, `extra_options`
  (object, chứa tuỳ chọn thứ ba như `Height`, `Size-Bottom`…).
- **Dạng object**: `options: { "Size": "S", "Color": "Black", "Height": "Regular" }`.

Tuỳ chọn ngoài Size/Color **phải** vào `options` / `extra_options`,
không được bỏ. Variant không có tuỳ chọn nào thì bị loại.

| Trường | Bắt buộc | Kiểu / ghi chú |
|---|---|---|
| `options` | Một trong hai dạng | Object `{ tên tuỳ chọn: giá trị }`. |
| `size` / `color` | Một trong hai dạng | Chuỗi. Tương đương `options.Size` / `options.Color`. |
| `extra_options` | Không | Object, vd `{ "Height": "Regular" }`. Gộp vào `options`. |
| `price` | Không* | Số, giá của variant. *Thiếu thì lấy giá cấp record (`productPrice`). Vẫn thiếu → `null`. |
| `compare_at_price` | Không | Số hoặc `null`, giá gốc trước giảm. |
| `currency` | Không | Mã tiền tệ của variant. |
| `in_stock` | Không | Boolean. Mặc định `true` trừ khi `in_stock === false` hoặc `available === false`. Amazon luôn gửi `true` (không xác minh được tồn từng tổ hợp — xem audit). |
| `stock_qty` | Không | Số hoặc `null`. **Dữ liệu Muse cũ không có** — luôn là `null` ở dữ liệu đó; CSV xuất `Quantity = 1` cho mọi dòng. |
| `sku` | Không | Chuỗi hoặc `null`. Thiếu thì CSV tự sinh `p_<hash>-<n>`. |
| `upc` | Không | Chuỗi hoặc `null`. **Dữ liệu Muse cũ không có UPC.** Lấy UPC của variant đầu tiên có UPC làm UPC cấp product. |
| `image` | Không | URL ảnh riêng của variant, hoặc `null`. |

## 4. Đối tượng lỗi crawl

Khi một record lỗi (thiếu site/id/title, giá không hợp lệ…), server
**không loại cả lô**: record lỗi được ghi lại, record tốt vẫn nhập.
`parseImport()` trả về lỗi theo shape này (cũng là shape lưu trong
kho lỗi crawl, xem qua `GET /api/crawl-errors`). Lưu ý hành vi server
(`server/api.mjs`): response `200` của `POST /api/ingest/records` không
kèm danh sách lỗi chi tiết — chỉ khi **không có record nào** nhập được
thì server trả `400 { "error": "invalid_products", "errors": [...] }`.

```json
{
  "source_site": "azazie",
  "source_product_id": "",
  "message": "missing source_product_id; missing title"
}
```

| Trường | Ghi chú |
|---|---|
| `source_site` | Slug đã chuẩn hoá (`normalizeSite()`), có thể là `""` nếu record không có site. |
| `source_product_id` | Chuỗi, có thể là `""` nếu thiếu. |
| `message` | Các lỗi nối bằng `"; "` (vd `missing source_site; missing title`, `price 5 outside reasonable range for ogl-move (20-500 USD)` — cảnh báo giá ngoài khoảng thì vẫn nhập, chỉ ghi vào message). |

Lỗi crawl của cả lô (vd crawler không đọc được một site) gửi kèm theo
cùng shape, trường `at` ghi thời điểm lỗi:

```json
{
  "source_site": "eileen-fisher",
  "source_product_id": "EF-123",
  "message": "Cloudflare blocked automated browser",
  "at": "2026-11-13T00:00:00.000Z"
}
```

## 5. Lưu ý khi tạo record

1. **Giá nằm ở variant.** Extension không gửi `price` cấp record; đừng
   tự thêm giá cấp record khi viết reader mới cho extension, trừ khi
   site thật sự chỉ có một giá chung.
2. **`flags.price_estimated: true`** khi giá biến thể là giá suy ra từ
   biến thể đang chọn (Amazon, Azazie, fallback generic). Team phải
   kiểm lại giá trước khi xuất.
3. **`crawl_truncated: true`** khi chưa đọc hết lựa chọn. Đừng im lặng
   bỏ biến thể — gắn cờ để team crawl lại.
4. **Giới hạn 250 biến thể** (`MAX_VARIANTS`): CSV eBay chỉ xuất tối đa
   250 biến thể còn hàng mỗi sản phẩm; vượt quá thì product bị gắn
   `truncated: true` và chỉ 250 dòng đầu được xuất. Azazie có 34 sản
   phẩm vượt giới hạn này trong dữ liệu Muse (HANDOFF mục 5).
5. **Không có UPC / số lượng tồn ở dữ liệu Muse cũ.** Đừng bịa UPC hay
   `stock_qty`; để `null`. CSV xuất `Quantity = 1`.
6. **Trùng lặp được gộp, không tạo mới:** gửi lại cùng
   `source_site + source_product_id` thì dữ liệu nguồn mới (giá, tồn,
   biến thể, ảnh, tiêu đề) thay dữ liệu cũ, nhưng phần team đã sửa
   (`edits`) và `product_type` vẫn giữ, `version` tăng 1.
7. **Tiền tệ phải là USD trước khi xuất.** Record `VND` vẫn nhập được
   nhưng bị chặn xuất; crawl lại sau khi đổi tiền tệ trang sang USD.

## 3. Ví dụ 3 — Soho Home (extension v1.1.0)

Soho Home **không phải Shopify**. Bộ đọc `readSohoHome()` lấy giá từ
JSON-LD `offers.price` = **giá non-member** (Member rẻ hơn ~20%, không
lấy), compare-at từ "Regular Price $X" đầu tiên trên trang, size từ tiêu
đề, specs từ mục "Details & Dimensions". Các size khác của thảm là trang
riêng — crawl từng URL, không gộp thành biến thể.

```json
{
  "source_site": "sohohome.com",
  "source_url": "https://www.sohohome.com/us/products/cavern-side-table",
  "source_product_id": "cavern-side-table",
  "crawled_at": "2026-11-13T00:00:00.000Z",
  "brand": "Soho Home",
  "title": "Cavern Side Table",
  "breadcrumb": ["Furniture", "Side Tables"],
  "description_text": "A square top crafted from a mix of travertine and marble.",
  "attributes": { "material": "Ash Wood, MDF, cement board, Grey Pesco Marble" },
  "specs": {
    "Dimensions": "H45 x W50 x D50cm / H18 x W20 x D20\"",
    "Material": "Ash Wood, MDF, cement board, Grey Pesco Marble, Jade Shell Marble, Travertine and Michelangelo Marble",
    "Weight": "15kg / 33.1lbs",
    "Care instructions": "Wipe with a damp cloth."
  },
  "images": ["https://assets.sohohome.com/images/original/296830-79940020-listingjpg.jpg"],
  "options": [],
  "variants": [
    { "sku": null, "price": 1470, "compare_at_price": 2095, "currency": "USD", "in_stock": true, "stock_qty": null, "upc": null, "image": null }
  ],
  "flags": { "price_estimated": false },
  "crawl_truncated": false
}
```

Server chuẩn hoá thành product: `source_site: "soho-home"`,
`price: 1470`, `suggested_category: "Tables"`,
`specs.Dimensions` giữ nguyên để xuất template eBay
(`C:Item Height/Width/Length`, `C:Item Weight`).

## 4. Trường `theme` (chủ đề / NGÁCH) và bulk crawl

| Trường | Bắt buộc | Ghi chú |
|---|---|---|
| `theme` | Không | Chủ đề do team ghi, dùng để chia nhóm xuất CSV (vd `"Bàn ghế"`, `"Gối"`). Lấy từ cột NGÁCH/TYPE trong sheet, hoặc dạng `"url \| chủ đề"` khi bulk crawl. Extension v1.1.0 gắn `theme` vào record trước khi gửi. |
| `category_id` | Không | Mã category eBay đã chốt (vd `"20563"`). Nhóm có `category_id` được ưu tiên khi chia nhóm và chỉ xuất bằng template của đúng category đó. |
| `specs` | Không | Thông số dạng key–value từ trang nguồn (Dimensions, Material, Weight, Composition, Care instructions...). Dùng để map sang các cột `C:*` khi xuất theo template eBay. |

Danh sách bulk crawl (extension v1.1.0, popup "Crawl hàng loạt") — ĐÃ BỎ
từ v9.2 (luồng crawl hàng loạt từ danh sách link / link Google Sheet
không còn nữa; crawl chỉ còn nút "Crawl AI trang này" từng trang).
`parseBulkList` và `parseSheetCsv` vẫn giữ trong `public/core.js` làm
thư viện (dùng trong `autoSheetToCsv` và test dựng dữ liệu sheet:
`parseSheetCsv` tự tìm cột link EBAY/Site và cột chủ đề TYPE/NGÁCH).
Xem `public/core.js` (`parseBulkList`, `parseSheetCsv`,
`groupProductsByTheme`, `parseEbayTemplate`, `buildEbayTemplateCsv`).
