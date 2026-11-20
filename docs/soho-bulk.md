# Soho Home + Crawl AI từng trang + Xuất CSV theo nhóm (v1.3.0)

Ngày kiểm: 13/11/2026. Nguồn: trang thật qua `browser.open` (không vượt
captcha), file template eBay thật category 20563 user gửi, ảnh chụp sheet
Sabo_Lucky_Rate 9 tab Soho Home.

## 1. Soho Home đọc được gì trên trang thật

Soho Home **KHÔNG phải Shopify** (URL `/us/products/<slug>` hoặc
`/us/products/<slug>/<id>`). Bộ đọc mới: `readSohoHome()` trong
`extension/src/dist/content.js` (extension v1.3.0, build từ
`extension/src/` — xem mục 4).

Trang thật đã kiểm:

| Trang | Kết quả |
|---|---|
| `cavern-side-table` | JSON-LD Product: tên "Cavern Side Table", offers.price **$1,470 USD**, availability InStock, 5 ảnh `assets.sohohome.com`. "Regular Price $2,095" là giá gốc/compare-at. Member price $1,176 — **không lấy**. Details & Dimensions: `H45 x W50 x D50cm / H18 x W20 x D20"`, Material: Ash Wood, MDF, cement board, Grey Pesco Marble, Jade Shell Marble, Travertine, Michelangelo Marble. Weight 15kg / 33.1lbs. |
| `catherine-rug-navy-round` | JSON-LD: tên "Catherine Rug Navy, Round, 200 x 200cm", offers.price **$2,450 USD**, InStock, 5 ảnh. Member $1,960 — không lấy. Regular Price $3,495 là compare-at. Composition: Pile 100% Wool, Base 100% Cotton, Overall 54% Wool / 46% Cotton. Dimensions `H200 x W200 x D3cm`. |

Quy tắc giá (quan trọng):

- **Giá lấy = JSON-LD `offers.price` = giá non-member** (giá người mua
  thường thấy). Giá Member rẻ hơn ~20%, chỉ dành cho member trả $175/năm
  — không được lấy làm giá nguồn.
- **Compare-at = "Regular Price $X" đầu tiên trên trang**, chỉ khi X lớn
  hơn giá hiện tại (Cavern: $2,095; Catherine: $3,495).
- **Size nằm trong tiêu đề** (", 200 x 200cm") hoặc Details & Dimensions.
  Các size khác của thảm (vd 170 x 240cm, giá Regular $12,995) là
  **trang sản phẩm riêng, giá riêng** — crawl từng URL riêng, không gộp
  thành biến thể của một trang.
- **Sheet Sabo_Lucky_Rate 9 ghi MIN-MAX 100$–1000$** là tiêu chí LỌC giá
  nguồn khi chọn sản phẩm đưa vào sheet, **không phải khoảng giá hợp lệ
  của Soho Home**. Giá thật Soho Home vượt 1000$ rất thường xuyên
  ($1,470 / $2,450 / $12,995). `SITE_RANGES['soho-home'] = [100, 5000]`
  trong `core.js` chỉ để cảnh báo, không chặn import.

Trường đọc được: title, brand = "Soho Home", giá USD, compare-at, ảnh
(đủ thứ tự, tối đa 24), mô tả (JSON-LD description + đoạn mở đầu Details
& Dimensions), specs (Dimensions, Material, Frame, Weight, Composition,
Care instructions...), breadcrumb, Size (nếu có trong tiêu đề), tồn kho
(từ JSON-LD availability).

Chưa đọc được: bộ chọn "Configure" (vd loại đá marble đổi giá) nếu có —
trang text fetch không thấy selector rõ ràng; seller bấm thử trên Chrome
thật rồi báo lại. Không có UPC, không có số lượng tồn (như các site khác).

## 2. Crawl hàng loạt — ĐÃ BỎ từ v9.2

> Luồng crawl hàng loạt (dán danh sách link `url | chủ đề`, chọn file
> CSV từ sheet, nút "Crawl danh sách" mở lần lượt từng link trong tab
> nền) đã bỏ từ v9.2 theo quyết định của user. Crawl chỉ còn 1 đường
> duy nhất: mở từng trang sản phẩm, bấm **"Crawl AI trang này"** trong
> popup extension v1.3.0 (xem README, mục v9/v9.2). Site chặn bot
> (Cloudflare) thì link đó báo lỗi, không vượt captcha — mở tay link đó
> trong Chrome rồi bấm "Crawl AI trang này".

## 3. Chia nhóm + xuất nhiều CSV theo template

`public/core.js`:

- `groupProductsByTheme(products)` — thứ tự: (a) `category_id` eBay đã
  chốt; (b) `theme` / `product_type` do team ghi (cột NGÁCH trong sheet
  hoặc theme đã duyệt); (c) từ khoá trong tiêu đề
  (cushion/pillow → Cushions & Pillows, categoryId 20563; rug → Rugs;
  lamp → Lighting; sofa/chair → Seating; table → Tables; mirror; bed;
  ...); (d) breadcrumb đầu tiên; (e) Other. Lưu ý: breadcrumb chỉ là
  fallback sau từ khoá, vì breadcrumb Soho thường rộng ("Furniture").
- `parseEbayTemplate(csvText)` — parse file template eBay thật:
  `{ version, template, categoryId, headers, infoRows, requiredAspects,
  recommendedValues }`. File mẫu: dòng 0 Info Version, dòng 1 header
  98 cột, dòng 2–4 trống, dòng 5–40 Info (categoryId 20563, required
  Type; Brand, recommended values từng aspect — danh sách Brand tràn
  nhiều dòng Info nên parser cộng dồn).
- `buildEbayTemplateCsv(products, template, config)` — giữ nguyên dòng
  Info Version, header y hệt template, các dòng Info gợi ý, rồi thêm dòng
  sản phẩm: `*Action=Add`, `CustomLabel=SKU`, `*Category=categoryId` của
  template, `*Title` ≤ 80 ký tự, `*C:Type` khớp giá trị gợi ý dài nhất
  trong tiêu đề (không khớp thì **để trống, không bịa**),
  `*C:Brand` (vd Soho Home), `C:Material/C:Color/C:Size/C:Room`,
  `C:Item Height/Width/Length` (từ Dimensions, vd `18 in`),
  `C:Item Weight` (vd `33 lb`), `PicURL` nối bằng `|`,
  `*Description` đã lọc script/link ngoài/ảnh, `*Format=FixedPrice`,
  `*Duration=GTC`, `*StartPrice` = giá bán đã tính, `*Quantity=1`,
  `*ConditionID=1000`, Relationship/RelationshipDetails như `buildCsv`
  cho sản phẩm nhiều biến thể.

Cột còn trống cần team điền trước khi upload (xem README): `*Location`,
`*DispatchTimeMax`, `*ReturnsAcceptedOption`, `ReturnsWithinOption`,
`RefundOption`, `ShippingCostPaidByOption`, và các Profile
(`ShippingProfileName`, `ReturnProfileName`, `PaymentProfileName`) — lấy
từ `config` nếu có (`ebayLocation`, `dispatchTimeMax`,
`returnsAcceptedOption`, `shippingProfileName`...), mặc định trống.

Web tham chiếu: tab **"Xuất CSV"** (nạp file template, xem nhóm, nút
**"Xuất CSV theo nhóm"** — mỗi nhóm 1 file, vd
`ebay-20563-cushions.csv`). Tab "Crawl hàng loạt" đã bỏ từ v9.2.
**Chỉ xuất nhóm có `categoryId` khớp template đang nạp** (vd nhóm gối
`20563` với template 20563). Nhóm chưa có `categoryId` (thảm, đèn, bàn
ghế — hiện chỉ biết categoryId 20563 của gối) hoặc khác category sẽ bị
bỏ qua kèm lý do: cần gán `category_id` cho sản phẩm, hoặc nạp template
của đúng category đó rồi xuất riêng. Không xuất bàn/thảm chung dưới
template gối — eBay sẽ từ chối vì thiếu `Type`.

## 4. Extension v1.0.0 vs v1.3.0 — nói rõ để không nhầm

- `extension-v1.0.0/` là **bản build gốc user gửi, giữ nguyên, không sửa**.
  Zip gốc chỉ có bản build, **không có source TypeScript**.
- `extension/src/` là bản sao của bản build đó (JS đã build, đọc được)
  làm gốc chỉnh sửa: thêm `readSohoHome`, thêm nút "Crawl AI trang này"
  vào popup, thêm quyền `tabs`, version lên **1.3.0**. Đây là source thực
  tế của v1.3.0 (không phải source TypeScript gốc — source TS gốc vẫn
  không có). Bulk crawl và luồng Sheet → CSV đã bỏ từ v9.2.
- `extension-v2/` là output của `npm run build:extension` (copy từ
  `extension/src/`; từ v9.2 không còn copy `public/core.js` thành
  `dist/core.js` vì popup không còn code nào dùng `CsvEbayCore`).
  Cài thử: Load unpacked `extension-v2/`.
- `npm run package` vẫn đóng gói v1.0.0 gốc (`dist/extension-v1.0.0.zip`).

## 5. Dán link Google Sheet — ĐÃ BỎ từ v9.2

> Luồng dán link Google Sheet (tự tải CSV của tab, trích link cột EBAY /
> Site chính, preview tick chọn rồi đưa vào bulk crawl) đã bỏ từ v9.2
> theo quyết định của user, cùng với tab "Crawl hàng loạt" của web và
> card Sheet → CSV trong popup extension v1.3.0. Hai hàm
> `parseGoogleSheetUrl` / `fetchGoogleSheetCsv` đã xoá khỏi
> `public/core.js`; `parseSheetCsv` vẫn giữ làm thư viện (đọc file CSV
> xuất từ sheet, dùng trong `autoSheetToCsv` và test).
>
> Bản sheet nguồn đã được kiểm tra ngày 13/11/2026: **HTTP 200, 117 link,
> 0 dòng lỗi**. Link sheet riêng không đưa vào repo. Fixture
> `tests/fixtures/Sabo_Lucky_Rate_9_Soho_Home.csv` giữ 117 dòng dữ liệu
> sản phẩm phục vụ regression; thông tin tài khoản và các cột kinh doanh
> không dùng trong test đã được xóa. Xem `tests/fixtures/README.md`.
> Kết quả phân tích — xem mục 6.

## 6. Luồng 1 nút "Sheet → CSV tự động" (v4) — ĐÃ BỎ từ v9.2

> Luồng 1 nút "Lấy từ Sheet và xuất CSV" (dán 1 link Sheet duy nhất,
> tool tự đọc sheet → mở từng link → phân loại → xuất CSV) đã bỏ từ
> v9.2 theo quyết định của user. Hàm `autoSheetToCsv` vẫn giữ trong
> `public/core.js` làm thư viện (dùng trong test dựng dữ liệu sheet),
> nhưng không còn UI nào gọi tới. Crawl chỉ còn nút **"Crawl AI trang
> này"** từng trang (xem README, mục v9.2).
>
> Các quy tắc dữ liệu dưới đây vẫn đúng cho sản phẩm đã có trong kho
> (dữ liệu lấy từ sheet): mỗi dòng lấy TYPE (A), NGÁCH/BRAND (E),
> TITLE (F), DESCRIPTION (G, HTML đầy đủ), SIZE (H), COST (L) và
> **GIÁ BÁN** (cột O). Quy tắc giá:

- COST dạng châu Âu: `"$395,00"` = 395.00 USD, `"$1.295,00"` = 1295.00
  USD — `parseMoneyCell()` xử lý cả dạng châu Âu và Mỹ (`$1,295.00`).
- **GIÁ BÁN trong sheet là giá bán eBay đã chốt — dùng làm StartPrice
  khi có** (Daxton COST $395 nhưng GIÁ BÁN $280). Chỉ tính lại bằng
  `calcSellPrice` khi sheet không có GIÁ BÁN. Không ghi đè GIÁ BÁN
  bằng công thức mặc định.
- DESCRIPTION HTML đã có ảnh chính `assets.sohohome.com` + bảng
  DIMENSIONS & SPECIFICATIONS: dùng làm mô tả và lấy ảnh chính làm
  PicURL khi trang chưa crawl được ảnh (`extractImageFromHtml`).

**Kết quả với file sheet thật (117 sản phẩm, test
`tests/auto-sheet.test.mjs`):**

| Nhóm | Số lượng | Xuất được? |
|---|---|---|
| Gối (cushions, 20563) | 53 (gồm 2 sham → Pillow Cover) | ✅ `ebay-20563-cushions.csv` — xem `examples/ebay-20563-cushions-real.csv` |
| Đèn (lighting) | 39 (gồm đèn tường/đèn trần — từ khoá `light`) | ❌ chưa có template |
| Phòng tắm (bath) | 8 (toilet roll holder, towel rack, bin, robe) | ❌ chưa có template |
| Gương (mirrors) | 7 | ❌ chưa có template |
| Ghế (seating) | 3 | ❌ chưa có template |
| Giường (beds) | 2 | ❌ chưa có template |
| Tủ (storage) | 1 | ❌ chưa có template |
| Other | 0 | — |

117/117 dòng có URL cột Site chính, chỉ 3/117 có URL cột EBAY; cả 2
cột có thì ưu tiên EBAY (Mayfair Towel Rack lấy ID 79933411 ở cột EBAY,
không lấy 79933428 ở cột Site chính). 4 dòng trống TITLE và COST
(GIÁ BÁN chỉ $0,49 — dòng 7, 59, 73, 76: Mayfair Toilet Brush Holder,
Daxton Square Cushion trùng, Vende Cushion, Antonia Cushion) bị loại
khỏi CSV và ghi rõ trong `skippedSheetRows`, không tự bịa tên/giá.
File gối thật: header khớp template 100%, 53 dòng, Title ≤80, Type
trong 22 giá trị cho phép (Cushion / Pillow Cover), StartPrice = GIÁ
BÁN trong sheet, PicURL đủ (ảnh từ DESCRIPTION sheet), Description
không còn thẻ `<img>`/`<script>`.

**Vẫn cần người kiểm trước khi upload:** Brand "Soho Home" không có
trong danh sách ~4.000 brand của template 20563 (cần upload thử để xác
nhận); Location / DispatchTimeMax / ReturnsAcceptedOption / các Profile
còn trống; dữ liệu chỉ từ sheet thì chỉ có 1 ảnh chính, chưa có biến
thể — dùng nút **"Crawl AI trang này"** trong extension để crawl đủ từ
trang.

## 7. Còn thiếu

- Template eBay cho các danh mục khác (thảm, đèn, bàn ghế...): mỗi danh
  mục cần 1 file template riêng, nạp vào tab Xuất CSV trước khi xuất
  nhóm đó. Hiện chỉ có template 20563 (gối/cushion).
- Upload thử file CSV theo template 20563 lên Seller Hub để xác nhận
  eBay nhận đúng (đặc biệt Relationship details khi có tuỳ chọn thứ ba,
  và Brand "Soho Home" có được nhận không).
- Cài extension v1.3.0 vào Chrome thật, bấm thử nút "Crawl AI trang
  này" trên 1 trang Soho Home thật, kiểm tra giá/ảnh/specs có đúng
  không (đặc biệt bộ chọn "Configure" của Soho Home chưa xác nhận được
  từ text fetch).
