# Audit extension "CSV Studio Crawler" v1.0.0 — đối chiếu với HANDOFF mục 4

Ngày audit: 13/11/2026. Phạm vi: **chỉ đọc code đã build sẵn** trong
`extension-v1.0.0/` (`dist/content.js`, `dist/popup.js`, `manifest.json`,
`popup.html`, `popup.css`). **Không cài vào Chrome thật, không bấm thử
trên trang thật**, nên mọi nhận xét "đủ / chưa đủ" dưới đây là suy ra từ
code, không phải kết quả kiểm trên trang thật. Kết quả kiểm trên trang
thật trong HANDOFF mục 2, mục 4 (OGL Move, AliExpress, eBay, Walmart)
là của bản ManusOps trước đó, không phải của bản build này.

## 1. Inventory — file trong zip

| File | Nội dung (đã đọc) |
|---|---|
| `manifest.json` | Manifest V3, `name: "CSV Studio Crawler"`, `version: "1.0.0"`. `permissions: ["storage", "activeTab", "scripting"]`. `optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]`. `action.default_popup: "popup.html"`. Không có `content_scripts` — popup tự tiêm script khi bấm (xem mục 3). |
| `popup.html` | Popup: nút `Crawl trang này`, form cấu hình (địa chỉ tool + khóa crawl), vùng trạng thái, link mở tool. |
| `popup.css` | Style của popup. |
| `dist/popup.js` | 9.310 byte, 196 dòng. Logic popup: cấu hình, ping, tiêm content script, gửi record. Nguồn ghi trong code: `src/connection.ts`, `src/popup.ts`. |
| `dist/content.js` | 54.433 byte, 1.050 dòng. Logic đọc trang. Nguồn ghi trong code: `src/extract.ts` (tiêu đề, giá, ảnh, thông số chung), `src/csvRecord.ts` (đọc biến thể), `src/content.ts` (listener `EXTRACT_CSV`). `EXTRACTOR_VERSION = "0.9.2"`. |
| **Tổng** | **6 file.** Không có source TypeScript, không có test, không có `package.json` / `tsconfig` trong thư mục extension. |

## 2. Luồng chạy (theo `dist/popup.js` + `dist/content.js`)

1. Popup mở: đọc `toolUrl` + `apiKey` từ `chrome.storage.local`, gọi
   `GET {toolUrl}/api/ingest/ping` với `Authorization: Bearer <key>`.
   Ping thành công trả `{ name }` (tên khóa) thì hiện "Đã kết nối".
2. Seller bấm **Crawl trang này**: popup kiểm tab đang mở phải là
   `http(s)`, rồi `chrome.scripting.executeScript({ files: ["dist/content.js"] })`
   để tiêm content script vào tab, sau đó `chrome.tabs.sendMessage(tab.id,
   { type: "EXTRACT_CSV" })`.
3. Content script nhận message, chạy `extractCsvRecord()`:
   `extractProductAsync()` đọc tiêu đề/giá/ảnh/thông số chung
   (`src/extract.ts`), rồi chọn reader biến thể theo site
   (`src/csvRecord.ts`), rồi `buildCsvRecord()` ráp record theo
   `record-format.md` và trả về qua `sendResponse({ ok: true, record })`.
4. Popup gửi `POST {toolUrl}/api/ingest/records`, body
   `{ "records": [record] }`, header `Bearer <key>`.
5. Popup đọc response và báo kết quả (xem mục 4).

Vì popup tiêm script khi bấm nên extension **không cần quyền đọc sẵn
mọi site** — đúng như HANDOFF mục 4. Nhược điểm: mỗi lần bấm đều tiêm
lại `dist/content.js`; listener chống đăng ký trùng bằng cờ
`globalThis.__csvStudioCrawler`.

## 3. Thứ tự chọn reader biến thể (`extractCsvRecord()`)

```js
if (source === "Walmart")      read = readWalmart();
else if (source === "Ebay")    read = readEbay();
else if (source === "Amazon")  read = readAmazon(product);
else if (source === "AliExpress") read = await readAliExpress();
else read = await readShopify(fetchJson) ?? await readSalesforce();
```

`source` do `sourceFromHost(location.hostname)` quyết định, fallback
`"Website"` nếu trang có JSON-LD product / `og:type=product` / dấu hiệu
Shopify / WooCommerce. Site nào không khớp reader nào thì `read = null`
→ `buildCsvRecord()` dùng một variant đơn mặc định
(`{ options: [], price: product.price, inStock: true }`) và gắn
`flags.price_estimated = true`.

## 4. Đối chiếu từng site với HANDOFF mục 4

| Site | Reader trong `dist/content.js` | Cách đọc (code đã đọc) | Kết luận theo code |
|---|---|---|---|
| **OGL Move / Shopify** | `readShopify(fetchJson)` | `GET /products/<handle>.js` (handle lấy từ pathname). Giá chia 100 (Shopify trả xu). `option1/2/3` map theo `product.options` (bỏ `Title = Default Title`). `available` → `in_stock`, `sku`, `barcode` → `upc`, `vendor` → `brand`, `description` strip HTML, `images`, `featured_image.src` → ảnh variant. | **Đủ.** Đúng như HANDOFF: đủ giá/tồn từng biến thể, gồm tuỳ chọn thứ ba. Là reader đầu tiên trong nhánh fallback nên mọi site Shopify đều được hưởng. |
| **eBay** | `readEbay()` | Tìm script inline chứa `variationCombinations`, cắt object `MSKU` (`sliceJsonObject`). Cần đủ `variationCombinations` + `variationsMap` + `menuItemMap` + `selectMenus`. Giá từ `binModel.price.value`, tồn từ `quantity.outOfStock !== true` (thiếu `quantity` thì `in_stock: null`). | **Đủ theo code**, khớp HANDOFF. Ngoài ra `extract.ts` còn có fallback hiển thị `ebayVariants()` (đọc `.x-sku` / `.x-msku__box-cont`) nhưng chỉ dùng cho trường `variants` hiển thị, **không** dùng cho record CSV. |
| **Walmart** | `readWalmart()` | Đọc `#__NEXT_DATA__` → `props.pageProps.initialData.data.product`, dùng `variantsMap` + `variantCriteria` (tên/giá trị qua `variantList`), giá `priceInfo.currentPrice`, tồn khi `availabilityStatus === "IN_STOCK"`, `usItemId` → sku, breadcrumb từ `category.path`. | **Đủ theo code**, khớp HANDOFF. Có bảo vệ riêng: `extractProductAsync()` fetch lại HTML trang nếu `__NEXT_DATA__` không phải của đúng sản phẩm (vd mở từ trang tìm kiếm), không khớp thì throw lỗi "Bấm F5 để tải lại trang rồi bấm đọc lại". |
| **AliExpress** | `readAliExpress()` → `walkChoices()` | Tự bấm lần lượt từng lựa chọn: selector `[class*="sku-item--property"]`, item `[data-sku-col]`, label bỏ hậu tố `UK/US/EU/CN/AU Size…`, disabled khi class chứa `soldOut`/`disabled`. Tối đa **150 lần đọc** (`MAX_WALK_READS = 150`), **delay 450ms** (`WALK_DELAY_MS`) giữa các lần bấm; chạm giới hạn thì `truncated: true`. Giá đọc từ `[class*="price-default--current"]` qua `moneyFromText()` — phát hiện `₫`/`VND` thì `currency: "VND"`. | **Khá, đúng như HANDOFF.** Chưa có gì trong code tự đổi tiền tệ sang USD — seller phải đổi tay (popup cũng cảnh báo khi response có `currency !== "USD"`). |
| **Prana / Eileen Fisher (Salesforce)** | `readSalesforce()` — generic, **không có reader riêng theo site** | Tự bấm từng lựa chọn qua `[data-attr]` / `[data-attr-value]` (tên attr viết hoa chữ đầu), click màu trước rồi size sau (nhóm size được đẩy xuống cuối). Đọc giá từ `.prices .sales .value` / `[itemprop="price"]`, ảnh từ `.primary-images img`. Dùng chung `walkChoices()` (150 lần, 450ms); lựa chọn cuối bị disabled thì đọc giá mà không bấm (`readLastWithoutClick: true`). | **Chưa hoàn chỉnh.** Code là generic theo cấu trúc `[data-attr]` — không có nhánh nào kiểm tra hostname Prana hay Eileen Fisher, không có selector riêng cho từng site. HANDOFF đã ghi: mới test bằng HTML dựng lại, Eileen Fisher chưa xác nhận cùng cấu trúc. Cần file HTML thật từ Minsu để viết test và xác nhận. Lưu ý thêm: `WOMEN_ONLY_SITES` trong code chỉ khớp `oglmove` và `eileenfisher` — Prana không có trong danh sách này nên `department` của Prana phải suy ra từ breadcrumb/title. |
| **Amazon** | `readAmazon(product)` | Đọc script inline: `dimensionsDisplay` (tên chiều) + `dimensionValuesDisplayData` (map ASIN → tổ hợp giá trị). Trả `estimated: true`. **Mọi variant lấy cùng giá** `product.price` (giá biến thể đang chọn), **`in_stock: true` cho mọi tổ hợp** (không kiểm tồn), `sku` = ASIN. | **Thấp, đúng như HANDOFF.** Giá ước tính, tồn không xác minh. `core.js` cũng ép `price_estimated: true` cho Amazon. |
| **Azazie** | **Không có reader riêng** | Không có nhánh nào cho Azazie trong `extractCsvRecord()`. Azazie rơi vào nhánh `readShopify() ?? readSalesforce()`: `readShopify` trả `null` (không có `/products/<handle>.js`), `readSalesforce` trả `null` nếu trang không có `[data-attr]`. Kết quả `read = null` → record chỉ có **một variant mặc định** (giá = giá trang, `in_stock: true`) và `flags.price_estimated = true`. | **Chưa có — thấp.** Đúng như HANDOFF ("chỉ biến thể đang hiện trên trang", gắn cờ `price_estimated`). Đây là site ưu tiên mà extension hiện đọc kém nhất. Cần HTML thật từ Minsu để viết `readAzazie()` theo quy trình HANDOFF mục 4. |
| **Zoro** (ngoài HANDOFF) | Không có reader biến thể riêng | Có trong `sourceFromHost()`, có thu ảnh riêng (`collectZoroImages`, dedupe theo size ảnh), mã sản phẩm từ `/i/(G\d+)` hoặc `[data-za="product-sku"]`. Biến thể: fallback generic (single variant). | Chỉ nhận diện + ảnh + mã; **không đọc bảng biến thể**. |
| **Staples** (ngoài HANDOFF) | Không có reader biến thể riêng | Có trong `sourceFromHost()`, thu ảnh riêng (nâng cấp ảnh `staples-3p.com` lên `wid=1200&hei=1200`, lọc logo/banner), mã từ `/product_(\d+)` / `productId` / `[data-product-id]`. Biến thể: fallback generic. | Chỉ nhận diện + ảnh + mã; **không đọc bảng biến thể**. |
| **Etsy** (ngoài HANDOFF) | Không có reader biến thể riêng trong `csvRecord.ts` | Có trong `sourceFromHost()`, thu ảnh riêng (`etsystatic.com/.../r/il/...`, nâng cấp ảnh), mã từ `/listing/(\d+)`. `extract.ts` có `etsyVariants()` đọc `select[id^="variation-selector"]` (tên + giá trị, bỏ hậu tố giá trong ngoặc) nhưng chỉ dùng cho trường `variants` hiển thị của `extractProduct()` — **`buildCsvRecord()` không dùng tới**, nên record CSV của Etsy vẫn là single variant mặc định. | Nhận diện + ảnh + mã có; **bảng biến thể chưa vào record CSV**. Nếu cần, phải nối `etsyVariants()` vào luồng `csvRecord` như HANDOFF mục 4 hướng dẫn viết reader mới. |
| **Site lạ / WooCommerce** | Fallback generic | `source = "Website"` khi có JSON-LD product. Giá/ảnh từ JSON-LD, `og:` tags, selector Woo/Shopify chung. Biến thể: `readShopify() ?? readSalesforce()`, nếu cả hai `null` thì single variant + `price_estimated: true`. | Chỉ biến thể đang hiện, gắn cờ ước tính — như HANDOFF ghi cho "Azazie và site lạ". |

### Thuộc tính chung (`buildCsvRecord()` — áp cho mọi site)

- `source_site`: hostname bỏ `www.` (vd `oglmove.com`); `source_product_id`:
  Shopify → `product.id`, các site có hàm riêng (ASIN, `usItemId`,
  `G\d+`, listing ID, item ID eBay…), còn lại → `sku` từ JSON-LD.
- `attributes`: lấy từ item specifics (`collectItemSpecifics()`):
  `material` / `fit` / `care` / `country_of_origin` / `dimensions`;
  `material` còn suy ra từ chuỗi `NN% <chất liệu>` trong mô tả.
- `breadcrumb`: ưu tiên breadcrumb do reader trả (Walmart), còn lại từ
  JSON-LD `BreadcrumbList` hoặc link breadcrumb trên trang (bỏ `Home`,
  tối đa 8).
- `department`: từ specifics `Department`, hoặc `"Women"` nếu hostname
  khớp `oglmove|eileenfisher`, còn lại suy từ breadcrumb/title/hints
  (Women/Men, không phân biệt được thì `null`).
- `images`: ưu tiên ảnh reader trả (Shopify), còn lại ảnh JSON-LD /
  ảnh riêng theo site (Amazon, Walmart, Zoro, Staples, Etsy).
- `options`: `read.optionNames` (vd `["Size","Color","Height"]`).

## 5. Popup — contract với server (`dist/popup.js`)

- Cấu hình lưu ở `chrome.storage.local`: `{ toolUrl, apiKey }`.
  `toolUrl` phải là `https` (cho phép `http` với `localhost` /
  `127.0.0.1`); `apiKey` phải bắt đầu bằng `csvk_`, nếu không form báo
  lỗi và không lưu. Khi lưu, popup xin quyền host
  `chrome.permissions.request({ origins: [toolUrl + "/*"] })`.
- Mọi gọi API qua `fetch({toolUrl}/api/{path})`, header
  `Authorization: Bearer <apiKey>`, `Content-Type: application/json`
  khi có body. **Nếu response không phải JSON thì coi là
  `access_blocked`** — tức Cloudflare Access đang chặn (xem README:
  phải mở Bypass cho `/api/ingest/*`).
- `GET /api/ingest/ping` → expect `{ name }` (tên khóa) để hiện trạng
  thái "Đã kết nối".
- `POST /api/ingest/records`, body `{ records: [record] }` → expect
  response `{ products: [{ title, variants, inStock, images, currency,
  priceEstimated }], updated }`. Popup báo: `"Đã thêm/cập nhật
  "<title>": <variants> biến thể, <inStock> còn hàng, <images> ảnh."`
  kèm cảnh báo khi `currency !== "USD"`, khi `priceEstimated`, khi
  `crawl_truncated`.
- Mã lỗi server popup đã dịch sẵn (`ERROR_TEXT`): `invalid_api_key`,
  `records_required`, `invalid_records`, `invalid_products`,
  `body_too_large`, `too_many_records`, `has_real_data`,
  `server_error`; cộng thêm `network` (không nối được tool) và
  `access_blocked` (Access chặn, xem README).
- **Lưu ý:** popup không tự kiểm `price_estimated`/`currency` trước
  khi gửi — việc chặn xuất tiền tệ khác USD nằm ở phía tool/server.

## 6. Thiếu sót đã thấy trong code (chưa kiểm trên trang thật)

1. **Không có source TypeScript trong zip** nên không rebuild / không
   chạy `npm run package` hay `test:extension` được từ bản này.
   `package.json` của repo trỏ `test:extension` tới
   `extension/src/csvRecord.test.ts` — file này không có trong
   workspace (thư mục `extension/src/` đã rỗng và đã xoá theo yêu cầu).
   Muốn sửa reader phải xin lại source từ người giữ zip, hoặc viết lại
   từ bản build (không khuyến nghị).
2. **Azazie chưa có reader riêng** — site ưu tiên nhưng chỉ đọc được
   biến thể đang hiện, gắn cờ ước tính. Cần HTML thật từ Minsu.
3. **Eileen Fisher chưa xác nhận cùng cấu trúc Salesforce với Prana**
   — `readSalesforce()` là generic `[data-attr]`, chưa có bằng chứng
   trong code rằng Eileen Fisher dùng đúng cấu trúc này.
4. **Extension throw lỗi khi không lấy được ảnh** (`extractProduct()`:
   `images.length === 0` → throw "Không lấy được ảnh sản phẩm"), và
   throw khi không có title/giá, khi trang không được hỗ trợ, khi
   Walmart chưa tải đúng dữ liệu. Tức một trang thiếu ảnh thì **không
   gửi record nào**, dù biến thể đã đọc được. Dữ liệu Muse có 216 sản
   phẩm thiếu ảnh (Prana 43, Eileen Fisher 170, Azazie 3) — các sản
   phẩm này sẽ không crawl được bằng extension cho tới khi có ảnh hoặc
   nới lỏng luật này.
5. **Amazon: tồn luôn `true`, giá mọi variant bằng giá variant đang
   chọn.** Team phải kiểm lại tay trước khi xuất.
6. **Etsy/Zoro/Staples: có nhận diện + ảnh nhưng không có reader biến
   thể trong luồng CSV** — record chỉ có một variant mặc định.
7. **Chưa có crawl nhiều tab / trang danh mục.** Popup chỉ xử lý tab
   đang mở, một sản phẩm mỗi lần bấm; không có vòng lặp qua danh sách,
   không có độ trễ giữa các trang. Đây là P1-10 trong HANDOFF.
8. **Không có cơ chế thử lại / hàng đợi khi gửi lỗi** — gửi lỗi thì
   popup chỉ hiện thông báo, seller phải bấm lại.
9. **Giới hạn lần bấm AliExpress/Salesforce (150) là giới hạn lần
   `click`**, không phải số variant: với 2 nhóm lựa chọn lớn, số variant
   đọc được có thể ít hơn 150 và vẫn bị gắn `truncated`.

## 7. Cách kiểm tiếp theo (khi có Chrome thật + HTML thật)

1. Cài unpacked từ `extension-v1.0.0/`, cấu hình tool URL + khóa,
   kiểm ping hiện tên khóa.
2. Crawl thử 1 sản phẩm mỗi site trong bảng mục 4, đối chiếu số biến
   thể / tồn / giá với trang thật; ghi lại site nào bị chặn
   (Cloudflare / Access Denied) — extension không vượt captcha, gặp
   chặn thì báo lỗi.
3. Với Azazie + Eileen Fisher: lưu trang thật (Cmd+S, "Webpage,
   Complete", trang có ≥ 2 màu, ≥ 2 size, 1 biến thể hết hàng) rồi
   viết reader theo HANDOFF mục 4, kèm test từ HTML rút gọn.
