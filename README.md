# CSV Listing eBay

> **Bản cập nhật 18/11/2026 — tập trung tool trước, backend nhân sự để sau.**
> Extension **1.3.7** sửa đọc nhãn thông số Soho Home; tool tra các trường theo **Category ID**, điền dữ liệu nguồn và xuất CSV để đối chiếu. Xem [quy trình và kết quả kiểm tra](docs/tool-workflow.md).
> Hướng dẫn đang dùng và các giới hạn: **[docs/tool-workflow.md](docs/tool-workflow.md)**.
> Các mục phiên bản bên dưới là lịch sử; ưu tiên hướng dẫn mới này khi có thông tin khác nhau.

## Chạy source từ GitHub

Yêu cầu Node.js 20 trở lên. Trong thư mục dự án, sao chép `.env.example` thành `.env` và tự điền cấu hình của bạn, rồi chạy `npm run build:extension`, `npm test` và `npm run dev`. Mở `http://localhost:8787`; cài extension bằng **Load unpacked** từ thư mục `extension-v2/`.

Repo không chứa khóa API, kho sản phẩm local, log hoặc CSV xuất thử. Dữ liệu local được tạo khi chạy tool. Mẫu CSV kiểm thử đã được ẩn thông tin tài khoản; xem [ghi chú fixture](tests/fixtures/README.md).

Web riêng cho nhân sự, chạy ở tên miền riêng, để biến sản phẩm của nhiều
site bán lẻ thành file CSV đăng bán trên eBay US. Tool có hai cách lấy dữ
liệu, cùng đổ vào một kho chung của team:

- **Seller tự crawl:** mở trang sản phẩm trên Chrome, bấm extension
  "CSV Studio Crawler" v1.0.0. Dữ liệu đọc từ trang thật.
- **Crawl tự động:** Muse hoặc crawler chạy theo lịch đẩy hàng loạt file
  JSON vào (`scripts/push-crawl.mjs`).

Sau đó nhân sự cấu hình giá, duyệt và sửa, rồi tải CSV lên eBay Seller
Hub. **Tool không đăng trực tiếp lên eBay.**

Người đặt việc: Minsu. Bản bàn giao đầy đủ: `~/workspace/user/files/HANDOFF.md`
(HANDOFF cập nhật 13/11/2026).

> **Web trong repo này (`public/`) chỉ là BẢN THAM CHIẾU tối thiểu.**
> User đã có web nhân sự riêng (chưa gửi file/repo). Bản tham chiếu ở đây
> để đối chiếu contract `/api/ingest` và luật `core.js`, không thay thế
> web thật của user. Khi có web thật, nối tiếp từ đó và bỏ hoặc giữ bản
> này làm mẫu đối chiếu.

## Sheet → CSV: 1 nút duy nhất (v4, 13/11/2026) — ĐÃ BỎ từ v9.2

> **Đã bỏ từ v9.2 (16/11/2026) theo quyết định của user:** luồng "dán 1
> link Google Sheet → bấm 1 nút Lấy từ Sheet và xuất CSV" không còn nữa
> — đã xoá khỏi popup extension v1.3.0 (không còn card Sheet → CSV, không
> còn ô dán link sheet) và khỏi web (đã xoá tab "Crawl hàng loạt").
> Crawl chỉ còn 1 đường duy nhất: mở từng trang sản phẩm, bấm
> **"Crawl AI trang này"** trong extension (xem mục v9.2). Các quy tắc
> dữ liệu dưới đây vẫn đúng cho sản phẩm đã có trong kho (giá, mô tả,
> phân nhóm, file thật đã xuất), chỉ cách đưa sản phẩm vào kho đã đổi.

**Quy tắc giá (ghi rõ để không nhầm):**

- COST trong sheet dùng định dạng châu Âu: `"$395,00"` = 395.00 USD,
  `"$1.295,00"` = 1295.00 USD (dấu `.` là nghìn, dấu `,` là thập phân).
  `parseMoneyCell()` xử lý cả hai dạng châu Âu và Mỹ (`$1,295.00`).
- **GIÁ BÁN trong sheet là giá bán eBay đã chốt — dùng làm StartPrice
  khi có** (vd Daxton COST $395 nhưng GIÁ BÁN $280). Chỉ tính lại bằng
  `calcSellPrice` (cấu hình giá) khi sheet không có GIÁ BÁN. Không ghi
  đè GIÁ BÁN bằng công thức mặc định.
- DESCRIPTION trong sheet đã là HTML đầy đủ (ảnh chính
  `assets.sohohome.com`, ABOUT THIS PIECE, bảng DIMENSIONS &
  SPECIFICATIONS): dùng làm mô tả + lấy ảnh chính làm PicURL khi trang
  chưa crawl được ảnh. Trang sản phẩm chỉ cần mở để xác minh giá hiện
  tại + lấy thêm ảnh/biến thể.

**Đã test bằng dữ liệu sheet Soho Home; fixture trong repo đã ẩn thông tin riêng**
(bản nguồn được kiểm tra ngày 13/11/2026: HTTP 200, 117 link;
link sheet riêng không đưa vào repo). File regression
`tests/fixtures/Sabo_Lucky_Rate_9_Soho_Home.csv` giữ cấu trúc và dữ liệu sản phẩm:
117/117 dòng
có URL cột Site chính, chỉ 3/117 có URL cột EBAY (cả 2 cột có thì ưu
tiên EBAY — vd Mayfair Towel Rack lấy ID 79933411 ở cột EBAY, không lấy
79933428 ở cột Site chính); 4 dòng trống TITLE và COST (GIÁ BÁN chỉ
$0,49: Mayfair Toilet Brush Holder, Daxton Square Cushion trùng, Vende
Cushion, Antonia Cushion) — pipeline **báo rõ và loại khỏi CSV, không
tự bịa tên/giá**; phân nhóm: gối 53 (gồm 2 sham → Pillow Cover), đèn 39
(gồm đèn tường/đèn trần — từ khoá `light`), phòng tắm 8, gương 7, ghế 3,
giường 2, tủ 1, Other 0. File thật đã xuất:
`examples/ebay-20563-cushions-real.csv` (53 sản phẩm, header khớp
template 100%, Title ≤80, Type trong 22 giá trị cho phép, StartPrice =
GIÁ BÁN trong sheet, PicURL đủ). Nhóm đèn/gương/phòng tắm/ghế/bàn/giường/
tủ **chưa có template nên chưa xuất được** — tool báo rõ, không xuất
nhầm sang template gối; cần xin template riêng từng danh mục từ Seller Hub.

**Vẫn cần người kiểm trước khi upload lên Seller Hub:**

- Brand **"Soho Home" không có trong danh sách ~4.000 brand của
  template 20563** — cần upload thử 1 dòng để xác nhận eBay có nhận
  không, hoặc chọn Unbranded.
- `Location`, `DispatchTimeMax`, `ReturnsAcceptedOption`,
  `ReturnsWithinOption`, `RefundOption`, `ShippingCostPaidByOption` và
  các Profile (Shipping/Return/Payment) còn trống trong template — team
  phải điền (hoặc cấu hình `config`) trước khi upload.
- Dữ liệu chỉ từ sheet (chưa crawl trang) thì ảnh chỉ có 1 ảnh chính,
  chưa có biến thể — kiểm lại ảnh/thông số trước khi upload; dùng nút **"Crawl AI trang này"** trong extension để crawl đủ từ trang.

## Lưu bền dữ liệu local (v5.1, 13/11/2026) — tắt Terminal mở lại vẫn còn

V5 trở về trước: dev server lưu sản phẩm, cấu hình giá, lỗi crawl và khóa
crawl trong RAM — tắt cửa sổ Terminal là mất hết, mở lại phải tạo khóa mới
và crawl lại 117 sản phẩm từ đầu.

Từ v5.1, dev server dùng `LocalFileStore` (`scripts/local-store.mjs`):
mỗi lần dữ liệu đổi là ghi ngay xuống file `data/local-data.json` trên máy
bạn (ghi file tmp rồi đổi tên, không sợ file dở dang), mở lại server là tự
tải lại sản phẩm + cấu hình + khóa crawl cũ (khóa cũ vẫn dùng được, không
cần tạo lại). File CSV đã xuất vẫn nằm ở Downloads như trước.

- **Không lưu key AI xuống file:** key AI vẫn chỉ ở RAM server, tắt server
  là mất, phải dán lại (đúng như v5 đã dặn). File local chỉ chứa sản phẩm,
  config, lỗi crawl và HASH của khóa crawl, không chứa khóa gốc.
- **File hỏng:** nếu file JSON bị hỏng thì server dời nó sang
  `data/local-data.json.corrupt-<thời gian>` rồi bắt đầu kho trống, không
  mất hẳn file cũ.
- **Đổi chỗ lưu file:** biến môi trường `CSV_STUDIO_DATA_FILE`.
- **Muốn làm sạch máy:** xoá file `data/local-data.json` rồi restart server.
  File này đã thêm vào `.gitignore`, không commit.
- **Bản deploy Cloudflare không đổi:** vẫn dùng D1, tính năng này chỉ cho
  dev server local.

## AI gợi ý (v5, 13/11/2026) — gọi LLM thật phía server

AI chỉ **gợi ý**: phân loại + điền Type khi tên không chứa từ khoá,
điền item specifics từ mô tả/specs, tối ưu title ≤80 ký tự. Bạn xem gợi ý
rồi bấm **Áp dụng** mới lưu — AI không tự áp dụng, không quyết giá bán,
không bịa Brand. Chi tiết đầy đủ: `docs/ai.md`.

- **Nhà cung cấp:** OpenAI-compatible (mặc định `gpt-4o-mini`) hoặc Google
  Gemini (mặc định `gemini-2.5-flash`, fallback `gemini-2.0-flash` nếu 2.5
  trả 404, có gói miễn phí). Key chỉ ở server:
  biến môi trường `AI_API_KEY` (file `.env` dev / `wrangler pages secret put`
  khi deploy) được ưu tiên, rồi tới key dán trong web (tab **AI gợi ý**,
  chỉ lưu trong RAM, mất khi restart). Key không bao giờ vào extension,
  không lưu localStorage, không trả ra ngoài qua API.
- **Lấy key Gemini miễn phí:** https://aistudio.google.com → **Get API key**
  (không cần thẻ, key mới bắt đầu bằng `AQ.`, key cũ bằng `AIza`). Dán key vào ô nhập trong web —
  không gửi key trực tiếp trong chat.
- **Giới hạn gói miễn phí Gemini:** model Flash miễn phí giới hạn khoảng
  **15 request/phút** — server tự giãn mỗi lần gọi ~4 giây khi gợi ý hàng
  loạt; gặp HTTP 429 thì dừng lại và báo rõ *"đã chạm giới hạn miễn phí,
  đợi 1 phút rồi bấm tiếp"* (sản phẩm đã gợi ý xong được bỏ qua, chỉ làm
  nốt phần còn lại). Đổi giãn cách: env `AI_MIN_INTERVAL_MS`.
- **Kiểm chứng đầu ra:** `ebayType` chỉ trong 22 giá trị cho phép của
  template 20563 (ngoài danh sách → để trống + warning), title ≤80, Brand
  lấy từ sản phẩm/sheet. LLM lỗi / timeout 20s / JSON hỏng → fallback về
  gợi ý theo luật kèm warning, route không crash.
- **Chưa test được:** chưa có key thật nên chưa gọi LLM thật end-to-end
  (chỉ test bằng mock fetch trong `tests/ai-providers.test.mjs`).

## AI phân loại nhóm + xuất CSV riêng từng nhóm (v6, 13/11/2026)

AI gom các sản phẩm **giống nhau / cùng loại** vào chung 1 nhóm, mỗi nhóm
xuất 1 file CSV riêng — sửa đúng điểm yếu của phân loại theo từ khoá
(tên "Dax", "Mayfair" không chứa từ khoá nên trước đây rơi vào nhóm Other,
AI gom đúng nhờ đọc mô tả).

- **Endpoint:** `POST /api/ai/group` — body `{ productIds: [...] }` hoặc
  `{ products: [...] }`, trả `{ assignments, groups, unclassified, warnings,
  provider, stopped429 }`. LLM gom theo **batch 20 sản phẩm/lần gọi**
  (117 sản phẩm = 6 lần gọi ≈ 25 giây giãn cách với Gemini miễn phí, rẻ
  hơn nhiều so với gợi ý từng món 117 lần gọi).
- **Dùng ở đâu:** web, tab **Duyệt** → nút **AI phân loại + xuất CSV theo
  nhóm** (hiện bảng tóm tắt từng nhóm TRƯỚC khi tải); web tự gom nhóm
  bằng AI khi đã có key. Extension v1.3.0 không gọi `/api/ai/group` —
  phân nhóm AI chạy trong web sau khi sản phẩm đã về kho (chưa có key
  thì dùng nhóm theo từ khoá như cũ và báo rõ).
- **Kiểm chứng:** mỗi sản phẩm đúng 1 nhóm; sản phẩm LLM không gán được
  vào nhóm **Chưa phân loại** + warning, không tự đoán thay. `ebayType`
  chỉ trong 22 giá trị cho phép khi nhóm là gối, nhóm khác thì `null`.
  Nhóm đã gom được lưu vào `edits.aiGroup` / `edits.aiGroupLabel` qua
  `PUT /api/products/:id` (kèm version check 409) để lần sau mở lại vẫn còn.
- **Xuất CSV:** hiện chỉ nhóm gối xuất được (`ebay-20563-cushions.csv`) vì
  mới có template 20563; nhóm đèn/gương/phòng tắm/ghế/bàn… thì báo rõ là
  chưa xuất được vì chưa có template, KHÔNG xuất nhầm sang template gối.
  Chi tiết: `docs/ai.md` (mục "AI phân loại nhóm").

## File CSV NHÁP riêng từng nhóm chưa có template (v7, 16/11/2026)

User còn rất nhiều sản phẩm khác và **không thể đưa hết template eBay
cho từng danh mục được** — hướng "đợi template từng nhóm" đã bế tắc.
v7 tự xoay bằng file nháp: mỗi nhóm chưa có template vẫn có 1 file CSV
riêng, dùng đúng cấu trúc 98 cột của template gối 20563 làm mẫu cột, điền
sẵn các cột chung (Title ≤80, Description, StartPrice = GIÁ BÁN trong
sheet, PicURL, Quantity=1, ConditionID=1000, Format=FixedPrice,
Duration=GTC), để trống Category + toàn bộ cột C: để team điền nốt khi
có template thật. Tên file bắt buộc có `DRAFT`, vd
`ebay-DRAFT-lighting.csv` — **chưa điền Category nên Seller Hub sẽ từ
chối**, chỉ dùng để xem trước và điền nốt, không upload nhầm.

- **AI gợi ý danh mục cho file nháp:** `POST /api/ai/draft-categories`
  (1 lần gọi cho tối đa 20 nhóm) — LLM gợi ý tên danh mục eBay có thể
  đúng (vd "Table Lamps") + các trường riêng nhóm đó thường cần (vd đèn:
  "Bulb Type", "Wattage"). Chỉ là gợi ý text "AI đoán, chưa xác minh",
  lưu vào `edits.draftCategorySuggestion` — KHÔNG BAO GIỜ ghi vào cột
  Category hay C:Type của file nháp. Không có key AI thì bỏ qua, file
  nháp vẫn tạo được.
- **Dùng ở đâu:** web, tab **Duyệt** → nút **AI phân loại + xuất CSV theo
  nhóm** (kết quả chia 2 mục: file upload được + file nháp, mỗi nhóm 1
  nút tải + danh sách cột còn trống + gợi ý AI); web tải cả file nháp
  kèm cảnh báo trong tóm tắt.
- **Ví dụ với sheet thật (117 sản phẩm):** file gối 53 sp upload được;
  file nháp: đèn 39, phòng tắm 8, gương 7, ghế 3, giường 2, tủ 1 — tổng
  60 sp trong 6 file nháp.
- **Bố cục file nháp (v8.1, 16/11/2026):** v7 đã lỡ để nguyên khối dòng
  Info của template gối trong file nháp — mở file gương trong Excel vẫn
  thấy "For categoryId: 20563" và danh sách giá trị Type toàn loại gối.
  Từ v8.1, file nháp chỉ còn: dòng Version, dòng header 98 cột, ĐÚNG 1
  dòng cảnh báo DRAFT ngay dưới header, rồi các dòng dữ liệu — không còn
  chuỗi "20563" hay dòng Info nào của gối. File upload được (gối và nhóm
  đã có mã Taxonomy) giữ nguyên các dòng Info đúng của danh mục đó.
- **Biến file nháp thành file upload được:** tải template thật của danh
  mục đó từ Seller Hub 1 lần rồi nạp vào tool (tab Xuất CSV → chọn file
  template). Hoặc nối eBay Taxonomy API để tự lấy CategoryId + aspects —
  đã làm trong v8 (mục dưới). Chi tiết: `docs/ai.md` (mục "File CSV NHÁP").

## eBay Taxonomy — tự tra mã danh mục thật từ eBay (v8, 16/11/2026)

v7 còn một lối cụt: file nháp chỉ thành file upload được khi user tải
template thật từng danh mục — mà user có rất nhiều danh mục. v8 nối
**eBay Taxonomy API** (API chính thức của eBay, đã xác minh từ tài liệu
eBay: `partnerhelp.ebay.com` Taxonomy API Quick Start Guide +
`developer.ebay.com` OpenAPI) để tool tự tra mã danh mục thật theo từ
khoá, kèm trường bắt buộc/khuyến nghị của danh mục đó.

- **Cách lấy khóa:** tạo tài khoản eBay Developers miễn phí tại
  `developer.ebay.com` → đăng nhập tài khoản eBay → tạo app → lấy
  **App ID (Client ID) + Cert ID (Client Secret)** production (sandbox
  dùng khóa riêng). Chỉ cần application token (client credentials grant),
  không cần quyền bán hàng. **Không gửi khóa trong chat** — dán vào web
  (tab AI gợi ý → mục eBay Taxonomy) hoặc đặt `EBAY_APP_ID` /
  `EBAY_CERT_ID` trong `.env` / wrangler secret. Khóa chỉ ở server (RAM),
  không log, không trả ra response, không lưu file/test/zip. Không có
  khóa thì tool vẫn chạy như v7 (file nháp DRAFT).
- **Luồng dùng:** tab **Duyệt** → **AI phân loại + xuất CSV theo nhóm** →
  tool TỰ tra mã eBay cho từng nhóm rồi TỰ ÁP mã vào sản phẩm (không còn
  bước tay nào ở giữa — từ v9.3 đã bỏ hẳn nút **Áp dụng mã**). Bảng tóm
  tắt hiện cột **Mã eBay** (gối: `20563 — đã có template gối`; nhóm đã
  tra mã: mã + đường dẫn + huy hiệu **đã xác minh từ eBay** / **tự áp
  từ eBay**; nhóm chưa có mã: "chưa có mã — file nháp" + chỉ còn 1 nút
  **Tìm lại** để chạy lại tra mã cho nhóm đó, tra được thì tự áp luôn).
  Nhóm có mã đã tự áp thì tải ngay file upload được
  `ebay-<categoryId>-<groupKey>.csv`, Category = mã đã xác minh; nhóm
  chưa có mã vẫn ra file nháp DRAFT + ghi rõ trong tóm tắt trước khi
  tải. Mã tra được lưu vào `edits.ebayCategoryId` (PUT kèm version
  check 409; lỗi 409 thì bỏ qua sản phẩm đó + warning, không dừng cả
  nhóm). Bảng kết quả tra mã giờ chỉ là bảng chỉ-đọc tóm tắt
  (Nhóm | Mã eBay | Đường dẫn / trường bắt buộc), không còn cột nút.
- **Hai nguồn mã, phân biệt rõ:** mã từ Taxonomy API (đã xác minh, tool
  tự áp) hoặc từ template thật mới được xuất file upload được;
  mã do AI đoán (`draftCategorySuggestion`, v7) KHÔNG BAO GIỜ ghi vào
  cột Category. Các cột C: điền theo aspect names Taxonomy trả về — chỉ
  điền giá trị đã có từ sản phẩm/sheet/AI đã duyệt, chưa có thì để trống
  + liệt kê trong báo cáo, không bịa. C:Type của gối (22 giá trị của
  template 20563) KHÔNG dùng cho danh mục khác.
- **Endpoint mới:** `GET /api/ebay/status`, `POST /api/ebay/config`,
  `DELETE /api/ebay/config`, `GET /api/ebay/check`,
  `GET /api/ebay/category-suggestions?q=...` (chỉ trả leaf category,
  tối đa 10, cache theo từ khoá trong RAM),
  `POST /api/ebay/resolve-groups` (trả cho mỗi nhóm
  `{categoryId, categoryName, categoryPath, verifiedFromEbay: true,
  requiredAspects[], recommendedAspects[]}` hoặc
  `{categoryId: null, warning}` khi không tra được).
- **Lưu ý:** mã danh mục eBay có thể thay đổi theo thời gian — trước khi
  upload lô lớn sau một thời gian dài, bấm "Tìm lại mã eBay cho nhóm
  chưa có mã" lại để tool kiểm tra lại.
  Chi tiết: `docs/ebay-taxonomy.md`.
- **v8.4 (16/11/2026) — sửa lỗi sai đường dẫn lấy trường danh mục:** v8–v8.3
  gọi `GET .../get_item_aspects?category_id=<id>` để lấy trường của danh
  mục, nhưng đường dẫn này KHÔNG tồn tại trong Taxonomy API — đường dẫn
  đúng là `get_item_aspects_for_category` (chỉ dùng cho leaf category;
  `fetch_item_aspects` là method khác, lấy trường của TẤT CẢ leaf trong
  1 lần gọi). Vì vậy eBay trả 404 cho mọi lần lấy trường → "Tra mã cho
  tất cả nhóm" trả 0 nhóm có mã dù "Kiểm tra kết nối" (getDefaultCategory-
  TreeId, đường dẫn khác) vẫn OK. Lỗi lọt qua test vì mock cũ khớp bằng
  `endsWith('/get_item_aspects')` — khớp đúng đường dẫn sai. Đã sửa đường
  dẫn trong `server/ebay-taxonomy.mjs`, cập nhật mock + thêm test hồi quy
  (assert đúng 1 lần gọi `/get_item_aspects_for_category` với đúng
  `category_id`, và 0 lần gọi `/get_item_aspects`).
- **Chưa kiểm chứng end-to-end với eBay thật trong lúc build** (không có
  khóa eBay thật): test dùng mock fetch (22 test trong
  `tests/ebay-taxonomy.test.mjs`). Cần user dán khóa eBay vào web trên
  máy họ rồi bấm "AI phân loại + xuất CSV theo nhóm" với sheet thật để
  xác nhận (từ v9.3 nút này tự tra mã + tự áp, không còn bước bấm tay).

## Crawl AI 1 trang + số liệu eBay tham khảo (v9, 16/11/2026)

Seller mở 1 trang sản phẩm trên web bán lẻ (Soho Home, Amazon...), bấm
nút trong extension, AI trích xuất toàn bộ thông tin rồi đưa về web để
seller tự tạo CSV — các cột của CSV vẫn lấy theo mã danh mục eBay
(Taxonomy v8). Extension lên **v1.2.0**.

- **Luồng dùng:** mở trang sản phẩm → bấm **"Crawl AI trang này"** trong
  popup (nút cũ "Crawl trang này" đã bỏ từ v9.2, chỉ còn nút AI) →
  extension đọc dữ liệu
  trang (JSON-LD + biến thể + text hiển thị, tối đa ~12.000 ký tự) rồi
  gửi về `POST /api/ai/extract-page` → server trích xuất bằng AI (Gemini/
  OpenAI đã cấu hình trong web, giãn ≥4s/lần như v5; gặp 429 thì dừng
  bulk và báo đợi 1 phút) → lưu thành sản phẩm trong tool. Không có key
  AI thì trích xuất theo luật từ dữ liệu trang đã đọc + warning rõ.
  Chưa cấu hình tool (địa chỉ/khóa crawl) thì extension giữ bản copy
  local của dữ liệu trang thô (`aiPagePending`, tối đa 50 trang) — cấu
  hình xong bấm lại để AI trích xuất.
- **Quy tắc bắt buộc (user chốt 16/11/2026):** SIZE và MÀU lấy ưu tiên
  từ trang gốc; trường nào trang không có thì để null + warning, KHÔNG
  bịa giá trị. Server kiểm chứng đầu ra LLM: giá chỉ nhận khi trang gốc
  có giá (LLM tự đưa giá khi trang không ghi giá → bỏ); ảnh chỉ giữ URL
  có trong dữ liệu trang gốc; màu/size biến thể phải khớp 1 giá trị
  option trên trang gốc hoặc xuất hiện trong text trang, không khớp →
  null + warning; giá biến thể phải khớp giá trên trang gốc hoặc bằng
  giá sản phẩm. Title cắt ≤80 ký tự; giá lấy giá non-member hiển thị
  trên trang (Soho Home: JSON-LD `offers.price`, KHÔNG lấy Member price).
- **Số liệu eBay (tham khảo, KHÔNG vào file CSV upload):** từ v9.1,
  tool TỰ ĐỘNG tìm listing eBay khớp qua Browse API ngay sau khi
  "Crawl AI trang này" (không cần dán link hay dán số nữa) — xem mục
  v9.1 dưới. Trước v9.1 (bản v9): trong popup, dán link listing eBay
  tương ứng rồi bấm "Lấy số đã bán trên eBay" → extension mở link eBay
  trong tab nền, đọc số "X sold" CÔNG KHAI trên trang listing (tổng cả
  listing) rồi lưu vào `product.ebaySold` + `ebayItemId`. Số người theo
  dõi (watchers): seller tự xem trên WatchCount rồi nhập tay vào form
  chi tiết sản phẩm trong web (tab Duyệt) → lưu vào `product.ebayWatchers`
  kèm nguồn "WatchCount (nhập tay)". Tab Duyệt hiện thêm 2 cột **Đã bán
  (eBay)** và **Người theo dõi**. Tab Xuất CSV có nút **"Xuất file
  research"** → 1 file riêng cho mỗi nhóm (`research-<nhóm>.csv`):
  Title, URL gốc, Giá bán lẻ, Giá bán eBay (GIÁ BÁN), Đã bán, Người
  theo dõi, CategoryId — chỉ để seller xem trước khi tạo CSV upload.
- **Giới hạn đã xác minh (đọc kỹ trước khi dùng):** trang bán lẻ không
  có lượt bán/lượt xem; trang listing eBay công khai hiện "X sold"
  (tổng số đã bán) nhưng không hiện số người theo dõi; WatchCount chỉ
  có số liệu theo từng listing (số người theo dõi, tổng số đã bán, tốc
  độ bán/ngày), KHÔNG chia theo màu/size, KHÔNG có API công khai,
  robots.txt của họ cấm bot cào trang nên tool KHÔNG tự động cào
  WatchCount. **Số bán/xem từng màu/từng size không tồn tại ở bất kỳ
  nguồn công khai nào — v9 không bịa ra số đó, chỉ lấy tổng cả listing.**
- **Endpoint mới:** `POST /api/ai/extract-page` — 1 trang
  `{url, sourceSite?, sourceProductId?, raw}` trả
  `{product, extracted, warnings, provider, rateLimited}`; hàng loạt
  `{pages: [...]}` tối đa 20 trang trả
  `{results: [...], stopped429, provider}`. `PUT /api/products/:id`
  nhận thêm `ebaySold`, `ebayWatchers`, `ebayItemId`,
  `ebayWatchersSource`.
- **Chưa kiểm chứng end-to-end với AI thật / eBay thật trong lúc build:**
  test dùng mock LLM + dữ liệu trang giả lập (21 test mới trong
  `tests/ai-extract-page.test.mjs`, 3 test mới trong
  `tests/extension.test.mjs`). Cần user chạy v9 trên máy họ với 1 trang
  Soho Home thật + key Gemini để xác nhận AI trích xuất.

## Tự động tìm listing eBay khớp + số liệu BÁN/XEM (v9.1, 16/11/2026)

User yêu cầu: "tự động dùng mã định danh đi đừng bắt tôi phải nhập tay
các thứ nữa" — v9.1 bỏ hẳn 2 bước nhập tay của v9 (dán link listing
eBay trong popup + dán số người theo dõi từ WatchCount). Extension lên
**v1.2.1** (popup không còn card "Số đã bán trên eBay").

- **Luồng dùng (không còn bước nhập tay):** mở trang sản phẩm → bấm
  **"Crawl AI trang này"** → web trích xuất xong thì TỰ ĐỘNG tìm
  listing eBay khớp (search theo tên + giá qua Browse API) rồi điền số
  đã bán (ước tính) + số người theo dõi; popup hiện luôn listing đã
  khớp + 2 số liệu. Tab Duyệt có thêm nút **"Tìm listing eBay cho tất
  cả sản phẩm chưa có số liệu"** (chạy cho sản phẩm cũ chưa có số liệu)
  và cột **"Listing eBay khớp"** (tên + điểm khớp, bấm vào xem listing).
  Từng sản phẩm có nút **"Tìm lại"** trong form chi tiết (chạy lại
  search, không cần gõ gì). Form chi tiết vẫn giữ ô nhập mã item eBay
  nhưng CHỈ là tuỳ chọn nâng cao để sửa khi khớp sai — nhập mã vào thì
  server lấy thẳng listing đó qua `get_item_by_legacy_id`, không cần
  dán số.
- **Cách khớp (`server/ebay-browse.mjs`):** `GET /buy/browse/v1/item_
  summary/search?q=<tên sản phẩm>` (tối đa 10 ứng viên) → chấm điểm
  từng ứng viên: tỉ lệ từ khoá tiêu đề gốc xuất hiện trong tiêu đề ứng
  viên + cộng tối đa 0,15 khi giá gần giá bán lẻ; ứng viên không chứa từ
  PHÂN BIỆT nào (vd "Daxton" — trùng "Square Cushion" không tính) thì
  điểm = 0; chỉ nhận ứng viên có điểm ≥ 0,50, không đạt thì KHÔNG gán
  bừa (ghi warning "không tìm thấy listing eBay khớp"). Listing đã
  khớp thì `GET /buy/browse/v1/item/{item_id}` lấy `watchCount` (số
  người theo dõi) và `estimatedAvailabilities[].estimatedSoldQuantity`
  (số đã bán ƯỚC TÍNH — eBay nói rõ đây là ước tính, không phải số
  chính xác tuyệt đối). Lưu vào `ebayItemId`, `ebayItemTitle`,
  `ebayItemUrl`, `ebaySold`, `ebayWatchers`, `ebayMatchScore`,
  `ebayMatchSource='browse-api'`.
- **Đã kiểm chứng trong tài liệu chính thức của eBay trước khi code
  (16/11/2026):** trang Browse API getItem ghi "All methods in the
  Browse API require an Application access token, which is obtained
  using the client credentials grant flow" — dùng CHUNG App ID + Cert
  ID đã cấu hình cho Taxonomy, KHÔNG cần seller consent hay user
  token; trang Item type ghi rõ có field `watchCount` và
  `estimatedAvailabilities` ("it is impossible to return the exact
  quantity. So instead of returning quantity, the estimated
  availability of the item is returned"); `search`, `getItem`,
  `getItemByLegacyId` mở cho mọi tài khoản; RIÊNG `GET /item`
  (getItems bulk) là limited-release chỉ dành cho đối tác chọn lọc nên
  KHÔNG dùng. Mọi gọi Browse API cần header
  `X-EBAY-C-MARKETPLACE-ID: EBAY_US`. Giới hạn Browse API khoảng 5.000
  calls/ngày (search + getItem = 2 calls/sản phẩm).
- **Giới hạn vẫn giữ nguyên:** số đã bán / người theo dõi là TỔNG cả
  listing, không chia theo màu/size (eBay không công bố số theo biến
  thể); WatchCount KHÔNG được cào (robots.txt cấm bot, không có API
  công khai) — v9.1 không gọi WatchCount nữa, số liệu lấy thẳng từ
  Browse API của eBay. `EXTRACT_EBAY_SOLD` trong content script được
  giữ làm dự phòng khi Browse API không trả số đã bán cho listing đó
  (đọc "X sold" công khai trên trang eBay).
- **Endpoint mới:** `POST /api/ebay/enrich {productId, ebayItemId?}`
  và `POST /api/ebay/enrich-all {productIds?}` (mặc định: tất cả sản
  phẩm chưa có `ebayItemId`, tối đa 200, giãn 200ms/sản phẩm, gặp 429
  thì dừng + `stopped429`). `POST /api/ai/extract-page` trả thêm
  `enrichment` (tự chạy sau khi lưu sản phẩm). `PUT /api/products/:id`
  nhận thêm `ebayItemTitle`, `ebayItemUrl`, `ebayMatchScore`,
  `ebayMatchSource`. File research thêm 2 cột **Link listing eBay** và
  **Điểm khớp**; file CSV upload Seller Hub giữ nguyên như v8.4.
- **Chưa kiểm chứng end-to-end với eBay thật trong lúc build:** test
  dùng mock fetch (9 test mới trong `tests/ebay-browse.test.mjs`).
  Cần user chạy v9.1 trên máy họ với khóa eBay thật: crawl AI 1 trang
  Soho Home thật rồi xem popup/tab Duyệt có hiện listing khớp + số đã
  bán + người theo dõi không; sản phẩm không khớp thì báo rõ warning.

## Ảnh trên Cloudflare (R2) (v9.1, 16/11/2026)

Link ảnh trong file CSV upload Seller Hub (cột PicURL) phải là link
Cloudflare, không dùng link ảnh gốc của trang bán lẻ nữa
(`assets.sohohome.com`...). Tool tự tải ảnh gốc rồi upload lên bucket
R2 của shop, trả về link công khai trên Cloudflare.

- **Luồng chạy:** sau khi sản phẩm được lưu (crawl AI 1 trang, crawl
  hàng loạt từ sheet, hoặc extension gửi record về), server thử upload
  từng ảnh trong `product.images` lên R2 (tuần tự, timeout 20s/ảnh,
  tối đa 20MB/ảnh). Ảnh upload được thì `product.images` đổi thành
  link Cloudflare, link gốc giữ trong `product.originalImages` để đối
  chiếu; PicURL trong CSV dùng `product.images` nên tự thành link
  Cloudflare. Ảnh lỗi (tải lỗi / upload lỗi) thì ảnh đó giữ link gốc +
  warning, các ảnh khác vẫn lên Cloudflare — không fail cả sản phẩm.
  Key ảnh trong bucket lấy theo hash SHA-256 của URL gốc
  (`images/<2 ký tự đầu>/<hash>.<ext>`) nên crawl lại cùng ảnh không
  upload trùng (cache trong RAM theo URL gốc; upload lại sau khi
  restart server cũng ghi đè đúng key đó với cùng nội dung).
- **Chưa cấu hình thì sao:** chưa điền đủ 5 biến R2 thì tool vẫn chạy
  bình thường, chỉ giữ link ảnh gốc + warning rõ trong kết quả (không
  lỗi, không chặn luồng). Điền xong thì ảnh mới từ lúc đó mới lên R2;
  ảnh cũ muốn lên R2 thì crawl lại sản phẩm đó.
- **Cách tạo (làm 1 lần, khoảng 5 phút):**
  1. Cloudflare dashboard (dash.cloudflare.com) → R2 Object Storage →
     **Create bucket**, đặt tên vd `csv-images` (chọn vị trí gần US).
  2. Bật truy cập công khai cho bucket — 1 trong 2 cách:
     - Nhanh để thử: bucket → Settings → Public access → bật R2.dev
       subdomain, lấy URL dạng `https://pub-xxx.r2.dev`.
     - Dùng domain riêng (nên làm khi chạy thật): R2 → bucket →
       Settings → Custom Domains → Connect Domain, nhập
       `images.tencongty.com` (domain đã về Cloudflare) → dùng
       `https://images.tencongty.com`.
  3. Tạo API token: R2 → Manage R2 API Tokens → Create API Token,
     quyền **Object Read & Write**, áp dụng cho bucket `csv-images` →
     lưu lại Access Key ID + Secret Access Key (Secret chỉ hiện 1 lần).
  4. Lấy Account ID: sidebar phải trong R2, mục "Account ID" (cũng là
     phần đầu của URL S3 API `https://<account-id>.r2.cloudflarestorage.com`).
  5. Điền vào `.env` (dev local, copy từ `.env.example`):
     `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID`,
     `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_BUCKET`,
     `CLOUDFLARE_R2_PUBLIC_URL` (domain ở bước 2, không có "/" ở cuối).
     Deploy Cloudflare thì đặt từng biến bằng
     `npx wrangler pages secret put <TÊN>`. Không commit key thật.
- **Kỹ thuật (`server/cloudflare-images.mjs`):** upload qua S3-compatible
  API của R2 (`PUT https://<account-id>.r2.cloudflarestorage.com/
  <bucket>/<key>`), ký SigV4 bằng WebCrypto thuần (không dependency
  ngoài, chạy được cả Node và Workers), region `auto`, service `s3`.
  Test: 7 test mới trong `tests/cloudflare-images.test.mjs` (mock fetch,
  không gọi Cloudflare thật).

## Bỏ luồng Sheet → CSV 1 nút, chỉ còn "Crawl AI trang này" (v9.2, 16/11/2026)

User quyết định: **không cần luồng "Sheet → CSV: 1 nút duy nhất" nữa**
(dán 1 link Google Sheet → tool tự đọc sheet, mở từng link, phân loại,
xuất CSV). Từ v9.2, crawl chỉ còn **1 đường duy nhất: mở từng trang sản
phẩm, bấm "Crawl AI trang này"** trong extension v1.3.0.

- **Extension v1.3.0:** popup xoá toàn bộ card "Sheet → CSV: 1 nút duy
  nhất" (ô dán link Google Sheet, nút "Lấy từ Sheet và xuất CSV", mục
  gập "Nhập tay từng link / lấy link rồi crawl riêng (nâng cao)") và mọi
  handler chỉ phục vụ luồng đó (`runSheetAuto`, `runBulk`,
  `crawlOneBulkUrl`, `crawlOneAutoUrl`, `fetchGoogleSheetCsv`,
  `downloadCsvFile`...). Trong card "Crawl sản phẩm trên trang này" xoá
  nút cũ "Crawl trang này" (rule-based) + handler `crawl()` /
  `describeResult`, **chỉ giữ nút "Crawl AI trang này"** + ghi chú dưới
  nút. Quyền `downloads` đã bỏ khỏi manifest (chỉ phục vụ tự tải CSV
  của luồng 1 nút); file template 20563 nhúng sẵn trong extension
  (`extension/src/ebay-template-20563.csv`) cũng đã xoá — template gối
  vẫn có trong web (`public/templates/ebay-20563.csv`). `content.js` bỏ
  nhánh message `EXTRACT_CSV` (không còn ai gửi), nhưng giữ nguyên
  `extractCsvRecord` vì `extractAiPage()` dùng chung để đọc dữ liệu thô.
  Nút AI chạy độc lập: chưa có key AI trong web thì server dùng dữ liệu
  đọc theo luật như ghi chú dưới nút đã nói (fallback có từ v9).
- **Web:** xoá luôn tab "Crawl hàng loạt" (toàn bộ tab là luồng sheet /
  danh sách link — web không tự crawl, và crawl hàng loạt của extension
  đã bỏ nên tab không còn tính năng nào khác). `public/app.js` bỏ
  import + state + handler của tab đó. **Sửa sẵn 1 lỗi cú pháp có từ
  v9.1** trong `app.js`: 1 dòng ghi chú về eBay Browse API bị thiếu
  `//` ở đầu dòng nên file không parse được — đã thêm lại.
- **Code lõi:** hàm lõi không còn ai gọi thì xoá + test của nó:
  `parseGoogleSheetUrl`, `fetchGoogleSheetCsv` (kèm `headerValue`),
  `parseSohoSizeFromTitle` (content.js có hàm riêng `sohoSizeFromTitle`
  nên không ảnh hưởng). GIỮ làm thư viện (còn dùng trong
  `autoSheetToCsv` / test fixture dựng dữ liệu sheet): `parseSheetCsv`,
  `parseBulkList`, `parseMoneyCell`, `autoSheetToCsv`,
  `productFromSheetItem`, `enrichProductFromSheet`,
  `extractImageFromHtml`, `normalizeSheetBrand`, `normalizeProductUrl`,
  `parseSohoDimensions`, `parseSohoWeight`, `groupProductsByTheme`,
  `groupProductsByAiAssignments`, `buildGroupedEbayCsvs`,
  `buildDraftGroupedCsvs`, `buildDraftTemplateCsv`,
  `draftMissingColumns`, `draftSuggestionsByGroup`.
- **Tests:** 236 → **224/224 pass**. `tests/google-sheet.test.mjs`
  đổi thành `tests/sheet-csv.test.mjs` (chỉ còn 1 test `parseSheetCsv`);
  `tests/auto-sheet.test.mjs` bỏ test UI luồng 1 nút;
  `tests/template.test.mjs` bỏ assert `parseSohoSizeFromTitle`;
  `tests/extension.test.mjs` viết lại cho v1.3.0 (manifest 1.3.0, không
  quyền `downloads`, popup chỉ còn nút AI, không còn sheet/bulk, không
  còn `EXTRACT_CSV`, không còn `dist/core.js`).
- **Chạy thử v9.2:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → cài extension v1.3.0 (Load unpacked, chọn
  `extension-v2/`) → mở 1 trang Soho Home → bấm nút duy nhất
  **"Crawl AI trang này"** → xem kết quả trong tab **Duyệt**.

## Tự động áp mã danh mục + danh sách "Đã cào được" gọn (v9.3, 16/11/2026)

User thấy giao diện sau khi cào "lằng nhằng quá" và yêu cầu bỏ hẳn bước
tra mã thủ công: không còn nút "Áp dụng mã" từng nhóm, mã danh mục phải
tự đưa vào luôn khi tra được; sau khi cào chỉ cần 1 danh sách liệt kê đã
cào được những thông tin gì.

- **Tự áp mã (auto-apply):** `public/app.js` — `resolveEbayGroups` sau
  khi `POST /api/ebay/resolve-groups` trả mã cho 1 nhóm thì TỰ ĐỘNG lưu
  mã đó vào mọi sản phẩm của nhóm (`PUT /api/products/:id` với
  `ebayCategoryId`, kèm version check 409; lỗi 409 thì bỏ qua sản phẩm
  đó + warning, không dừng cả nhóm). CHỈ tự áp mã có
  `verifiedFromEbay=true` — mã do AI đoán (`draftCategorySuggestion`)
  KHÔNG BAO GIỜ được tự áp hay ghi vào cột Category (giữ quy tắc v8,
  có test khẳng định). Nút **AI phân loại + xuất CSV theo nhóm** tự tra
  mã + tự áp TRƯỚC khi xuất, nên không còn bước tay nào ở giữa; nhóm
  nào sau khi tự tra vẫn chưa có mã thì vẫn ra file DRAFT + ghi rõ trong
  tóm tắt trước khi tải. Bảng kết quả tra mã thành bảng chỉ-đọc tóm tắt
  (Nhóm | Mã eBay | Đường dẫn / trường bắt buộc), không còn cột nút;
  nhóm chưa có mã chỉ còn 1 nút **Tìm lại** (chạy lại resolve cho nhóm
  đó, tra được thì tự áp luôn). Cột **Mã eBay** trong bảng tóm tắt nhóm
  ở tab Duyệt hiện mã đã tự áp kèm nhãn "đã xác minh từ eBay" / "tự áp
  từ eBay". Sửa sẵn 1 lỗi có từ v9.2: nút "Áp dụng mã" cũ gọi hàm
  `apiPut` — hàm này chưa từng tồn tại trong repo, nên nút cũ bấm vào
  sẽ lỗi ReferenceError; nay đã xoá hẳn nút và hàm.
- **Danh sách "Đã cào được":** 1 danh sách gọn duy nhất, thay cho các
  bảng/nút rườm rà. Web, tab Duyệt, khi mở chi tiết 1 sản phẩm (kể cả
  sản phẩm vừa cào xong): Tiêu đề, Giá, Ảnh (n ảnh), Mô tả (có/không +
  số ký tự), Chất liệu, Kích thước, Biến thể (từng màu/size + giá từng
  biến thể), Listing eBay khớp (tên + link), Đã bán (eBay, ước tính),
  Người theo dõi, Mã danh mục (đã tự áp). Trường nào chưa có thì ghi
  "chưa có" — KHÔNG bịa giá trị. Hàm dựng danh sách:
  `crawledSummaryItems(product, config)` trong `public/core.js`
  (13 dòng từ v9.5 — thêm Bóng đèn + Chăm sóc, dùng chung logic
  `applyEdits`/`optionNamesFor` của web).
  Extension **v1.3.2** (từ v9.5): popup sau khi bấm **"Crawl AI trang này"** hiện
  đúng danh sách gọn tương tự (13 dòng từ v9.5, link listing mở tab mới), trạng
  thái chỉ còn 1 dòng ngắn; giữ nút mở web để xem chi tiết. Chưa cấu
  hình tool thì popup vẫn hiện danh sách với các trường có sẵn ở bản
  local.
- **Tests:** 224 → **230/230 pass**. 5 test mới trong
  `tests/auto-apply.test.mjs` (a: mã verified → PUT đúng
  `ebayCategoryId` từng sản phẩm + bảng kết quả không còn nút áp mã;
  a2: lỗi 409 ở 1 sản phẩm → chỉ tính failed, sản phẩm khác vẫn áp;
  b: mã AI đoán → KHÔNG gọi PUT; c: danh sách "Đã cào được" đủ 13 dòng
  (từ v9.5 — thêm Bóng đèn + Chăm sóc) + trường thiếu hiện "chưa có"; d: nhóm tra mã thất bại → hiện "Tìm
  lại", bấm lại thì tự áp khi tra được) + 1 test mới trong
  `tests/extension.test.mjs` (popup v1.3.1 hiện danh sách "Đã cào
  được"), manifest 1.3.1, zip `dist/extension-v1.3.1.zip`.
- **Chạy thử v9.3:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → cài lại extension v1.3.1 (Load unpacked,
  chọn `extension-v2/`) → mở 1 trang Soho Home → bấm **"Crawl AI trang
  này"** → popup chỉ hiện 1 danh sách "Đã cào được" → vào web tab
  **Duyệt** → bấm **"AI phân loại + xuất CSV theo nhóm"** → mã danh mục
  tự áp luôn, không còn nút "Áp dụng mã" nào nữa.

## C:Type tự điền theo danh sách giá trị Taxonomy (v9.4, 16/11/2026)

User báo kèm ảnh Excel: 1 dòng đèn "Fleur Table Lamp, US", danh mục 19591
(Lighting Kits, đã tự áp mã OK), nhưng cột *C:Type BẮT BUỘC trống — file
chỉ có Title + Brand (Soho Home) + Material (Metal).

- **Nguyên nhân:** `mapEbayType` chỉ khớp 22 giá trị cho phép của template
  gối 20563; đường xuất cho danh mục khác bỏ qua nó và điền Type qua
  `aspectFromProduct`, mà AI trích xuất (v9) + reader trang đều không sinh
  trường Type nên luôn trống — mọi danh mục khác gối đều không bao giờ có
  C:Type dù đã tra mã xong.
- **Sửa:** giá trị cho phép của aspect (kể cả `values`) giờ được giữ nguyên
  qua cả chuỗi tra mã → tự áp → lưu edits → xuất file (trước đây các hàm
  `applyTaxonomyResolutions` / `autoApplyEbayResolutions` /
  `resolvedCategoryFromEdits` chỉ giữ tên aspect, làm mất `values`);
  lúc xuất file, `mapResolvedCategoryType` khớp Type theo danh sách giá
  trị cho phép của chính danh mục đó: ưu tiên `edits.ebayType` team đã
  duyệt (chỉ khi nằm trong danh sách), rồi Type từ dữ liệu sản phẩm
  (aiSpecifics đã duyệt / attrs / specs, chỉ khi nằm trong danh sách),
  rồi giá trị dài nhất có trong tiêu đề / product_type / theme. Chỉ điền
  khi khớp được 1 giá trị nằm TRONG danh sách cho phép; không khớp thì
  để trống + warning trong file nhóm (hiện ở tóm tắt xuất CSV), không bịa.
  File nháp vẫn để trống Type như cũ (chưa có mã). Tương thích ngược:
  dữ liệu cũ lưu dạng tên-only (không có `values`) thì Type lấy từ dữ
  liệu sản phẩm như hành vi cũ. `taxonomyMissingAspects` cũng kiểm tra
  Type bằng đúng logic khớp lúc xuất, để Type đã điền không bị báo thiếu
  oan. File mẫu chứng minh: `examples/ebay-19591-fleur-table-lamp-SAMPLE.csv`
  (+ `-NOTES.md`) — C:Type = "Table Lamp" đã điền.
- **Tests:** 230 → **234/234 pass**. 4 test mới trong
  `tests/ebay-taxonomy.test.mjs` (hồi quy đèn Fleur 19591: C:Type =
  "Table Lamp", values được giữ qua các tầng, missingAspects không còn
  Type; tiêu đề không khớp → trống + warning; `edits.ebayType` ngoài
  danh sách → không điền, trong danh sách → điền; dữ liệu cũ tên-only
  vẫn lấy Type từ specs như cũ). Lưu ý: giá trị Type của 19591 trong
  test + file mẫu là GIÁ TRỊ GIẢ LẬP hợp lý, chưa xác nhận từ Taxonomy
  thật của eBay cho 19591; lúc chạy thật, danh sách lấy từ
  `getItemAspects` của đúng danh mục đó.
- **Chạy thử v9.4:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → bấm **"AI phân loại + xuất CSV theo nhóm"**
  → file đèn 19591 giờ có C:Type đã điền. Phần StartPrice / Description
  / PicURL trống trong ảnh của user đã sửa ở **v9.5** (mục dưới) — file
  mẫu Fleur đã tạo lại từ dữ liệu thật, đủ giá/mô tả/ảnh.

## Cào trang Soho Home đủ giá/mô tả/ảnh/specs NGAY CẢ KHI CHƯA CÓ KEY AI (v9.5, 16/11/2026)

User cào trang Fleur Table Lamp thì file CSV ra trống StartPrice /
Description / PicURL — nhưng cào trực tiếp trang đó cho thấy trang CÓ đủ
dữ liệu (giá non-member $315, mô tả đèn nấm, 7 ảnh, kích thước, bóng E26,
care lau khăn khô). Lỗi ở phần trích xuất của tool, không phải do trang
thiếu. Từ v9.5, các trường đó được điền từ chính trang gốc (JSON-LD +
panel "Details & Dimensions" + gallery ảnh) **ngay cả khi chưa dán key
Gemini** — AI chỉ bổ sung khi có key, không phải điều kiện bắt buộc.

- **Nguyên nhân (đã xác minh bằng probe với payload thật của extension
  v1.3.1):** (a) `extractAiPage` gửi `price: record.price` nhưng
  `buildCsvRecord` không có field price ở cấp record (giá chỉ nằm ở từng
  biến thể) nên server luôn nhận `price: null` và tưởng trang không có
  giá; (b) `normalizeAiExtractedPage` chỉ nhìn giá top-level nên giá
  đúng của LLM cũng bị loại là "bịa" khi giá trang chỉ ở biến thể; (c)
  bộ trích xuất theo luật không bao giờ đào text trang (`pageText`) nên
  khi reader bỏ lỡ panel "Details & Dimensions" (accordion đóng lúc
  extension đọc) thì mô tả/specs mất hết; (d) nhãn specs của extension
  thiếu toàn bộ trường đèn (Bulb type, Wattage, Cable length...); (e)
  `readSohoHome` trả null khi JSON-LD thiếu giá, làm mất luôn specs/mô
  tả/ảnh đã đọc được; (f) giá gốc $450 (Regular Price) bị mất vì biến
  thể gửi đi không kèm compareAt.
- **Sửa (server, `server/ai.mjs`):** thêm `parseSohoDetailsText` —
  đào panel "Details & Dimensions" từ text phẳng: intro trước nhãn đầu
  tiên làm mô tả, rồi các cặp nhãn — giá trị (Dimensions, Shade, Base,
  Weight, Bulb type, Number of bulbs, Bulb included, Wattage, Light
  source, Dimmable, Switch, Cable length, Cable colour, Voltage, Care
  instructions...); từ trong câu mô tả (vd "half-sphere shade is
  paired...") không bị nhầm thành nhãn; từ "switch" lặp trong chính giá
  trị của nó được gộp, không cắt. `enrichRawWithPageDetails` lấp mô tả/
  specs còn thiếu từ panel trước khi trích xuất (cả đường LLM lẫn đường
  luật). `materialPhraseFromDescription` suy cụm chất liệu từ câu mô tả
  (vd Fleur: "Milky-white glass and lacquered sprayed metals" — trang
  không có nhãn Material riêng). Giá trang gốc = giá top-level HOẶC giá
  biến thể rẻ nhất; giá LLM chỉ nhận khi khớp 1 giá trên trang (khớp thì
  giữ, lệch thì dùng giá trang + cảnh báo, trang không có giá mà LLM đưa
  giá thì loại — không bịa). LLM không trả biến thể thì dùng biến thể
  reader. Giá gốc (compare-at) lấy từ top-level / biến thể / "Regular
  Price $..." trong text trang, chỉ khi lớn hơn giá bán.
- **Sửa (extension v1.3.2, `extension/src/dist/content.js` +
  `popup.js`):** `extractAiPage` gửi giá/currency/compareAt top-level
  suy từ biến thể (biến thể còn hàng rẻ nhất) và kèm compareAt trong
  từng biến thể; `sohoSpecsFromText` thêm nhãn đèn + dạng "Nhãn: giá
  trị" trên cùng 1 dòng; `sohoDetailsText` có fallback đọc panel qua
  DOM (`textContent` đọc được nội dung accordion đóng); `readSohoHome`
  không trả null chỉ vì thiếu giá JSON-LD (chỉ null khi không đọc được
  gì: không tiêu đề, không giá, không panel) và mô tả fallback sang
  `og:description`; SKU CHỈ lấy từ JSON-LD (sku/mpn/productID) — dãy
  số trong tên file ảnh (vd 79971888) KHÔNG phải SKU, tuyệt đối không
  dùng làm SKU. Manifest 1.3.1 → **1.3.2**, zip
  `dist/extension-v1.3.2.zip`.
- **Danh sách "Đã cào được" giờ 13 dòng** (web + popup): thêm **"Bóng
  đèn"** (Bulb type + Wattage, vd "E26 — 60W") và **"Chăm sóc"** (Care
  instructions) sau dòng Kích thước; chưa có thì "chưa có", không bịa.
- **File mẫu tạo lại từ dữ liệu thật:**
  `examples/ebay-19591-fleur-table-lamp-SAMPLE.csv` (+ `-NOTES.md`) —
  Category 19591, C:Type "Table Lamp", StartPrice **315.00**, Description
  đủ, PicURL = ảnh listing chính, C:Material là cụm chất liệu của trang,
  C:Bulb Type "E26", C:Item Height "19.3 in", C:Care Instructions lau
  khăn khô, SKU trống đúng thực tế. Mô tả trong file là diễn đạt lại,
  chỉ giữ nguyên 1 câu chất liệu của trang.
- **Tests:** 234 → **247/247 pass**. 13 test mới trong
  `tests/soho-fleur-v95.test.mjs` + fixture
  `tests/fixtures/fleur-table-lamp-raw.mjs` (payload thật của Fleur
  như extension v1.3.1 gửi: price top-level null, giá chỉ ở biến thể,
  specs reader thiếu nhãn đèn, panel đầy đủ trong pageText; + payload
  chỉ còn pageText): đào panel đúng (không cắt mô tả ở từ "shade" trong
  câu, gộp "switch" lặp), cụm chất liệu từ câu mô tả, rule-based không
  cần key AI vẫn đủ giá/mô tả/ảnh/specs + không cảnh báo sai, trang thật
  sự không có giá thì báo đúng, giá LLM khớp/lệch/không có giá trang,
  POST `/api/ai/extract-page` không key vẫn lưu đủ + SKU trống, CSV
  19591 end-to-end (StartPrice 315.00, Type Table Lamp, Bulb Type E26,
  Material/Size/Care đủ), danh sách "Đã cào được" 13 dòng (Bóng đèn
  "E26 — 60W"). Cập nhật test auto-apply (11 → 13 dòng) và extension
  test (1.3.1 → 1.3.2, đủ 13 nhãn).
- **Chạy thử v9.5:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → cài lại extension **v1.3.2** (Load unpacked,
  chọn `extension-v2/`) → mở trang Fleur Table Lamp → bấm **"Crawl AI
  trang này"** (KHÔNG cần dán key Gemini) → danh sách "Đã cào được"
  hiện Giá $315.00, Mô tả có, Ảnh 7 ảnh, Chất liệu, Kích thước, Bóng đèn
  "E26 — 60W", Chăm sóc lau khăn khô → bấm **"AI phân loại + xuất CSV
  theo nhóm"** → file đèn 19591 có đủ StartPrice/Description/PicURL.

## Cào đủ gallery ảnh Soho Home, tối đa 12 ảnh, lên Cloudflare R2 (v9.6, 18/11/2026)

User báo: cào trang Soho chỉ được 1 ảnh, trong khi cần cào hết ảnh sản
phẩm (tối đa 12 ảnh) và lưu ảnh lên Cloudflare R2 để PicURL trong CSV
là link Cloudflare.

- **Nguyên nhân (đã xác minh):** `readSohoHome()` trong extension chỉ
  lấy `ld.image` của JSON-LD (thường chỉ có 1 ảnh chính), bỏ qua gallery
  trong DOM; `buildCsvRecord()` lại ưu tiên `read.images` nên gallery
  mà `collectImages()` đọc được cũng bị bỏ. Prompt AI cũng chỉ gửi 10
  ảnh đầu cho LLM (`server/ai.mjs`).
- **Sửa (extension v1.3.3, `extension/src/dist/content.js`):** thêm
  `collectSohoHomeImages()` — JSON-LD trước (ảnh listing chính đứng
  đầu), rồi quét gallery trong DOM (`assets.sohohome.com`), bỏ tile sản
  phẩm khác + nav/header/footer/recommend/related, tối đa 12 ảnh.
  Dedupe theo phần sau `/images/original/` (tên file gốc): cùng 1 ảnh
  ở nhiều crop khác nhau (trim/width khác nhau) chỉ tính 1 lần, góc
  khác nhau (listing/hover/lifestyle/detail...) có tên file khác nhau
  nên giữ đủ. `collectImages()` có nhánh Soho riêng và `readSohoHome()`
  dùng chung hàm này, không còn chỉ lấy `ld.image`. SKU vẫn CHỈ lấy từ
  JSON-LD — số trong tên file ảnh KHÔNG phải SKU. Manifest 1.3.2 →
  **1.3.3**, zip `dist/extension-v1.3.3.zip`.
- **Sửa (server, `server/ai.mjs`):** prompt trích xuất gửi 12 ảnh đầu
  cho LLM thay vì 10 (`slice(0, 12)`). Giới hạn chống bịa ảnh của LLM
  vẫn giữ: `cleanExtractImages` tối đa 24, ảnh LLM trả về phải có trong
  dữ liệu trang gốc mới được giữ.
- **Cloudflare R2 (không đổi code, đã kiểm bằng test):**
  `uploadImages()` trong `server/cloudflare-images.mjs` đã lặp hết
  danh sách ảnh — 12 ảnh mock → 12 link Cloudflare (12 lần PUT), 1 ảnh
  lỗi thì chỉ ảnh đó giữ link gốc, 11 ảnh còn lại vẫn lên. R2 chưa cấu
  hình thì giữ link gốc + warning, không chặn luồng. Key R2 chỉ ở
  `.env` trên máy user, không có trong zip.
- **CSV:** `public/core.js` đã nối đủ `p.images` bằng `|` vào PicURL ở
  dòng đầu tiên của sản phẩm (tối đa 24 ảnh, không cần sửa) — test khóa
  sản phẩm 12 ảnh xuất PicURL đúng 12 URL, ảnh listing đứng đầu.
- **Tests:** 247 → **257/257 pass**. 10 test mới trong
  `tests/soho-images-v96.test.mjs`: chạy `content.js` thật trong VM với
  trang Soho mô phỏng (JSON-LD chỉ 1 ảnh + gallery DOM 7 ảnh Fleur →
  trả đủ 7 ảnh, ảnh listing đầu tiên; crop trùng + tile sản phẩm khác +
  ảnh nav bị loại; gallery 14 ảnh → tối đa 12); prompt AI đủ 12 ảnh,
  ảnh thứ 13 không gửi; LLM trả 12 ảnh thật thì giữ đủ 12, ảnh bịa vẫn
  bị loại; R2 12 ảnh → 12 link Cloudflare, 1 ảnh lỗi chỉ giữ link gốc
  cho ảnh đó; CSV 19591 PicURL đúng 12 URL. File mẫu Fleur có sẵn
  (`examples/ebay-19591-fleur-table-lamp-SAMPLE.csv`) đã có PicURL 7
  ảnh — v9.6 chứng minh bằng test rằng reader thật giờ cũng trả đủ 7
  ảnh đó thay vì chỉ 1 ảnh JSON-LD như v9.5.
- **Chạy thử v9.6:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → cài lại extension **v1.3.3** (Load unpacked,
  chọn `extension-v2/`) → mở trang Fleur Table Lamp → bấm **"Crawl AI
  trang này"** → danh sách "Đã cào được" hiện Ảnh 7 ảnh → bấm **"AI
  phân loại + xuất CSV theo nhóm"** → file đèn 19591 có PicURL 7 URL.
  Nếu R2 đã cấu hình đủ 5 biến `CLOUDFLARE_R2_*` trong `.env` và bật
  public access cho bucket `dropship-images` thì PicURL là link
  Cloudflare; chưa cấu hình thì PicURL vẫn là link gốc
  `assets.sohohome.com` + warning rõ, không lỗi.

## Nhãn đèn tường Floria + giá £ trang UK (v9.7, 18/11/2026)

User test Floria Wall Light (Calacatta Viola Marble, IP44, UK) trên v9.6:
danh sách "Đã cào được" vẫn thiếu Bóng đèn, giá hiện "$175.00" trong khi
trang UK ghi £175. Ảnh (5 ảnh) và R2 thì đã xong sau khi user điền đủ
5 biến `CLOUDFLARE_R2_*` vào `.env` và chạy lại `npm run dev`.

- **Nguyên nhân (đã xác minh từ trang Soho Home thật):** panel "Details &
  Dimensions" của đèn tường dùng nhãn khác hẳn đèn bàn Fleur — 'Bulb
  required: 1/G9/5W Maximum' và 'Bulb style: Tala 4W G9 LED' thay cho
  'Bulb type', kèm 'Bulb(s) included: No', 'Electrician required: Yes',
  'IP Rating: IP44', 'Bathroom safe: Yes' — không nhãn nào trong số đó
  có trong `SOHO_DETAIL_LABELS` nên cả reader extension, server
  `parseSohoDetailsText` và danh sách "Đã cào được" đều bỏ qua. Riêng
  giá: popup và web hard-code ký hiệu `$` nên £175 hiện thành $175.00.
- **Sửa (extension v1.3.4 + server + web):** thêm 6 nhãn trên vào
  `SOHO_DETAIL_LABELS` (`server/ai.mjs`) và bộ nhãn của reader
  (`extension/src/dist/content.js`); dòng Bóng đèn trong popup
  (`extension/src/dist/popup.js`) và web (`public/core.js`) giờ gộp
  'Bulb required' / 'Bulb type' / 'Bulb style' + 'Wattage', vd Floria
  hiện "1/G9/5W Maximum — Tala 4W G9 LED — 5W Max", Fleur vẫn "E26 —
  60W" như cũ. Giá hiển thị theo đúng tiền tệ trang gốc (GBP → £,
  USD → $, EUR → €...); giá trị số KHÔNG đổi, StartPrice trong CSV vẫn
  là số trên trang, giá bán gợi ý trên eBay US vẫn $.
- **Tests:** 257 → **261/261 pass**. 4 test mới trong
  `tests/soho-floria-v97.test.mjs`: parse panel Floria thật ra đủ 10
  specs; reader chứa đủ 6 nhãn mới; "Đã cào được" của Floria hiện Bóng
  đèn đủ 3 phần + Giá £175.00; Fleur không hồi quy.
- **Chạy thử v9.7:** giải nén zip → `npm test` → `npm run dev` → mở
  `http://localhost:8787` → cài lại extension **v1.3.4** (Load unpacked,
  chọn `extension-v2/`, Remove bản 1.3.3 cũ trước) → mở trang Floria →
  bấm **"Crawl AI trang này"** → danh sách "Đã cào được" phải hiện Giá
  £175.00, Ảnh 5 ảnh, Bóng đèn "1/G9/5W Maximum — Tala 4W G9 LED —
  5W Max", Kích thước H13.6 x W16.3 x D16.3cm, Chăm sóc lau khăn khô.
  Lưu ý: server chỉ đọc `.env` lúc mới khởi động — điền xong `.env`
  phải tắt Terminal rồi chạy lại `npm run dev` mới có R2 / key AI / key
  eBay, nếu không popup vẫn báo "chưa cấu hình" dù file `.env` đã đủ.

## Kiến trúc

```
 Seller (Chrome)                 Crawler tự động (Muse, cron)
   extension: đọc trang             file JSON
        │                               │ scripts/push-crawl.mjs
        └──── POST /api/ingest/records ─┘   Authorization: Bearer csvk_...
                       │  (Access: Bypass, tự kiểm khóa)
                       ▼
        server/api.mjs ── Core.parseImport + mergeProducts ──► D1 (products, meta, api_keys)
                       ▲
   Nhân sự (web) ──────┘  /api/* còn lại: đăng nhập Cloudflare Access
   Nhập → Cấu hình → Duyệt và sửa → Xuất CSV (CSV tạo ngay trên trình duyệt bằng core.js)
```

- **Kho dữ liệu (D1):** bảng `products` lưu mỗi sản phẩm một dòng JSON,
  có `version` để chống ghi đè khi hai người cùng sửa (trả 409). Bảng
  `meta` giữ cấu hình chung, catalog template và danh sách lỗi crawl.
  Bảng `api_keys` giữ khóa crawl (chỉ hash). Schema:
  `migrations/0001_init.sql`.
- **Luật nằm ở `public/core.js` và chạy hai nơi:** trình duyệt dùng để
  duyệt và xuất, server dùng để chuẩn hoá dữ liệu nhận vào. Sửa luật thì
  sửa một chỗ, thêm test vào `tests/`.
- **Nhập lại cùng sản phẩm:** dữ liệu nguồn mới (giá, tồn, biến thể,
  ảnh, tiêu đề) thay dữ liệu cũ. Phần team đã sửa (`edits`) và lựa chọn
  loại sản phẩm vẫn giữ. Mã sản phẩm băm từ
  `source_site|source_product_id`.
- **Site ưu tiên:** OGL Move, Azazie, Prana, Eileen Fisher. Sau đó:
  Amazon, Walmart, eBay, AliExpress (và Zoro/Staples/Etsy trong
  extension — xem `docs/extension-audit.md`).

## Contract `/api/ingest`

Định dạng record đầy đủ: [`record-format.md`](record-format.md).
Audit extension v1.0.0 đối chiếu HANDOFF mục 4:
[`docs/extension-audit.md`](docs/extension-audit.md).

### `GET /api/ingest/ping`

- Header: `Authorization: Bearer csvk_...`
- Không có khóa / khóa sai → **401 JSON** `{ "error": "invalid_api_key" }`
  (không phải trang đăng nhập Access — xem mục Deploy, app Bypass).
- Thành công → `{ "ok": true, "name": "<tên khóa>" }` (tên khóa popup dùng
  để hiện trạng thái "Đã kết nối").

### `POST /api/ingest/records`

- Header: `Authorization: Bearer csvk_...`, body
  `{ "records": [record, ...] }` (record theo `record-format.md`).
  Giới hạn server: body tối đa 6 MB, tối đa 200 records/request.
- Response thành công (shape popup v1.0.0 expect):
  `{ "ok": true, "updated": true|false, "products": [{ "id", "title", "variants", "inStock", "images", "currency", "priceEstimated", "price" }], "stats": { "total", "imported", "mergedDuplicates", "errors" } }`
  - `products[i].variants`: số biến thể; `inStock`: số biến thể còn hàng;
    `priceEstimated`: giá các biến thể chỉ lấy theo biến thể đang chọn.
  - `updated: true` khi có ít nhất một record đã có trong kho.
  - `stats.errors`: số record lỗi. **Lưu ý:** response 200 không kèm
    danh sách lỗi chi tiết — record lỗi được lưu vào kho lỗi crawl
    (`GET /api/crawl-errors`, tối đa 100 khi trả về) và chỉ trả về trong
    body lỗi `400 { "error": "invalid_products", "errors": [...] }` khi
    **không có record nào** nhập được.
- Mã lỗi popup đã dịch sẵn: `invalid_api_key`, `records_required`,
  `invalid_records`, `invalid_products`, `body_too_large`,
  `too_many_records`, `has_real_data`, `server_error`.
- Crawler đẩy lô tối đa 1,5 MB hoặc 200 bản ghi, giữ mọi bản ghi của một
  sản phẩm trong cùng một lô.

### Các endpoint web dùng (cần Access, không dùng khóa crawl)

| Endpoint | Dùng cho |
|---|---|
| `GET /api/bootstrap` | Tải toàn bộ sản phẩm + cấu hình + lỗi crawl + khóa một lần (`{ products, config, crawlErrors, keys }`). Ổn tới ~5.000 sản phẩm; lớn hơn cần phân trang — P2. |
| `GET/PUT /api/products/:id` | Sửa sản phẩm (`{ edits, version }`); version lệch → 409 `version_conflict`. Trả `{ product }`. |
| `GET/PUT /api/config` | Cấu hình giá: `{ markupPct, ebayFeePct, shippingCost, taxPct, roundTo99 }`. |
| `GET/POST /api/keys` | Liệt kê / tạo khóa crawl. List trả `{ id, name, createdAt, lastUsedAt }` (không lộ hash). Tạo trả `201 { id, name, key, createdAt }` — khóa mới chỉ trả về **một lần** lúc tạo. `DELETE /api/keys/:id` để thu hồi. |
| `GET /api/crawl-errors` | Danh sách lỗi crawl đã lưu (`{ source_site, source_product_id, message, at }`, tối đa 100). |
| `POST /api/ai/suggest` | Gợi ý AI: gửi `{ productId }` (hoặc `{ product }`), trả `{ suggestion: { title, category, ebayType, specifics }, warnings, provider }` — `provider` là `openai` / `gemini` khi gọi LLM thật, `rule-based` khi chưa có key hoặc LLM lỗi và đã fallback. AI chỉ gợi ý, người duyệt quyết định (bấm Áp dụng mới lưu). Xem `docs/ai.md`. |
| `POST /api/ai/group` | AI gom nhóm (v6): gửi `{ productIds: [...] }` hoặc `{ products: [...] }` (tối đa 200), trả `{ assignments: [{productId, groupKey, groupLabel, ebayType}], groups: [{key, label, categoryId, productIds, sampleTitles, count}], unclassified, warnings, provider, stopped429 }`. LLM gom theo batch 20, gặp 429 thì dừng gọi LLM và dùng nhóm theo từ khoá cho phần còn lại. Không có key → `rule-based`. Không tự lưu edits — client lưu qua `PUT /api/products/:id`. |
| `GET /api/ai/status` | Trạng thái AI: `{ configured, provider, model, source }` (nguồn key: `env` / `web` / `none`) — không bao giờ trả key. |
| `POST /api/ai/config` | Lưu key AI dán trong web vào RAM server: `{ provider?, model?, baseUrl?, apiKey? }`. Trả status, không trả key. Sai provider → 400 `invalid_provider`. |
| `DELETE /api/ai/config` | Xoá key/cấu hình đã dán trong web khỏi RAM (key trong env `AI_API_KEY` nếu có thì vẫn còn). |
| `GET /api/ebay/status` | Trạng thái eBay Taxonomy (v8): `{ configured, marketplace, environment, source }` — không bao giờ trả key. |
| `POST /api/ebay/config` | Lưu khóa eBay dán trong web vào RAM server: `{ appId, certId, environment? }`. Trả status, không trả key. Sai môi trường → 400 `invalid_environment`. |
| `DELETE /api/ebay/config` | Xoá khóa eBay đã dán trong web khỏi RAM (khóa trong env `EBAY_APP_ID` / `EBAY_CERT_ID` nếu có thì vẫn còn). |
| `GET /api/ebay/check` | Kiểm tra kết nối eBay: gọi thử getDefaultCategoryTreeId, trả `{ connected, categoryTreeId, marketplace, environment }`. |
| `GET /api/ebay/category-suggestions?q=...` | Tra tay 1 mã danh mục (v8): chỉ trả leaf category `{id, name, path}`, tối đa 10, cache theo từ khoá trong RAM. Thiếu `q` → 400 `query_required`. |
| `POST /api/ebay/resolve-groups` | Tra mã eBay cho nhiều nhóm (v8, tối đa 50 nhóm): gửi `{ groups: [{groupKey, label, sampleTitles[]}] }`, trả `{ results: [{groupKey, categoryId, categoryName, categoryPath, verifiedFromEbay, requiredAspects, recommendedAspects, warning}], warnings, provider: 'ebay-taxonomy' }`. Nhóm không tra được mã thì `categoryId: null` + warning, giữ file nháp, không bịa mã. Từ v9.3 web TỰ ÁP mã đã xác minh vào sản phẩm ngay sau khi tra được (PUT `/api/products/:id` kèm version check 409) — không còn nút "Áp dụng mã" nào. Xem `docs/ebay-taxonomy.md`. |

## Chạy local

```bash
npm test          # chạy tests/ — 16/11/2026 (v9.2): 224/224 test đạt (core + ingest + template + extension + sheet-csv + ai-providers + ai-group + draft-csv + ebay-taxonomy + bom-dedupe + ai-extract-page + ebay-browse + cloudflare-images)
npm run dev       # server dev, mặc định http://localhost:8787
npm run build:extension   # build extension v1.3.0 (chỉ còn nút Crawl AI trang này) -> extension-v2/
```

Dev server (`scripts/dev-server.mjs`, Node http, port 8787) phục vụ file
tĩnh từ `public/` và route `/api/*` qua `handleRequest` + MemoryStore
(dữ liệu chỉ trong bộ nhớ, restart là mất — khác với D1 trên Cloudflare).

Mở `http://localhost:8787` — bản tham chiếu có 6 tab: **Duyệt** (bảng sản
phẩm, cột biến thể động theo `option_names` — hiện cả tuỳ chọn thứ ba
như Height/Size Type; bấm vào dòng xem chi tiết đủ options/size/color/
`extra_options`/UPC/`price_estimated`/`truncated`), **AI gợi ý** (cấu
hình key AI + key eBay Taxonomy, gợi ý từng món / phân loại nhóm / tra
mã eBay), **Cấu hình giá**, **Xuất CSV** (tải file `.csv` tạo bằng
`buildCsv`, hoặc nạp template eBay thật rồi **Xuất CSV theo nhóm** bằng
`buildEbayTemplateCsv` — mỗi nhóm 1 file, vd
`ebay-20563-cushions.csv`), **Khóa crawl** (báo lỗi khi bỏ trống tên,
hiện khóa một lần), **Nhập** (dán JSON records + khóa `csvk_…` →
`POST /api/ingest/records`, có nút kiểm ping). Tab "Crawl hàng loạt"
đã bỏ từ v9.2 (xem mục v9.2).

### Load extension unpacked (Chrome thật)

```bash
npm run package           # v1.0.0 gốc -> dist/extension-v1.0.0.zip
npm run build:extension   # v1.3.0 (chỉ còn nút Crawl AI trang này) -> extension-v2/ + dist/extension-v1.3.0.zip
```

Rồi mở `chrome://extensions` → bật **Developer mode** → **Load unpacked**
→ chọn `dist/extension-v1.0.0/` (v1.0.0) hoặc `extension-v2/` (v1.3.0).
Mở popup, nhập địa chỉ tool + khóa crawl (tạo trong web, tab Khóa crawl),
bấm **Crawl AI trang này** trên một trang chi tiết sản phẩm. Chi tiết từng
site đọc ra sao: `docs/extension-audit.md`.

## Soho Home + xuất CSV theo nhóm (v1.3.0)

Chi tiết đầy đủ: [`docs/soho-bulk.md`](docs/soho-bulk.md).

- **Soho Home không phải Shopify.** Extension v1.1.0 đọc qua JSON-LD:
  giá lấy là **giá non-member** (Member rẻ hơn ~20%, không lấy),
  compare-at từ "Regular Price $X", size từ tiêu đề, specs từ mục
  "Details & Dimensions". Các size khác của thảm là trang riêng — crawl
  từng URL. Sheet ghi MIN-MAX 100$–1000$ là tiêu chí lọc giá nguồn,
  **không phải** khoảng giá hợp lệ của Soho Home (giá thật $1,470 /
  $2,450 / $12,995).
- **Crawl từng trang (từ v9.2, chỉ còn 1 đường):** mở trang sản phẩm,
  bấm **"Crawl AI trang này"** trong popup extension v1.3.0 — AI trích
  xuất thông tin rồi đưa về web (xem mục v9). Luồng crawl hàng loạt từ
  danh sách link / link Google Sheet đã bỏ từ v9.2 theo quyết định của
  user; file sheet thật Sabo_Lucky_Rate 9 vẫn giữ làm dữ liệu tham chiếu
  (`~/workspace/user/files/Sabo_Lucky_Rate_9_Soho_Home.csv`).
- **Xuất theo nhóm:** `groupProductsByTheme()` chia theo categoryId đã
  chốt → theme team ghi → từ khoá tiêu đề → breadcrumb. Nạp file
  template eBay thật của từng danh mục (mỗi danh mục 1 template riêng)
  rồi bấm "Xuất CSV theo nhóm" — mỗi nhóm 1 file đúng template đó
  (header, dòng Info giữ nguyên). Cột nào không có dữ liệu thì để trống,
  **không bịa** — đặc biệt `*Location`, `*DispatchTimeMax`,
  `*ReturnsAcceptedOption` và các Profile
  (Shipping/Return/Payment): **team phải điền** (hoặc cấu hình trong
  `config`: `ebayLocation`, `dispatchTimeMax`, `returnsAcceptedOption`,
  `shippingProfileName`, `returnProfileName`, `paymentProfileName`)
  **trước khi upload lên Seller Hub**, nếu không eBay sẽ báo thiếu.
- Template mẫu đã có: category **20563** (gối/cushion, 98 cột, required
  Type; Brand) — file user gửi ngày 13/11/2026. Các danh mục khác (thảm,
  đèn, bàn ghế...) cần xin template riêng từ eBay Seller Hub. File CSV
  mẫu đã xuất từ template này: `examples/ebay-20563-cushions-sample.csv`
  (1 gối Soho Home, Type=Throw Pillow, Brand=Soho Home). File thật từ
  sheet Sabo_Lucky_Rate 9 (v4): `examples/ebay-20563-cushions-real.csv`
  (53 gối, StartPrice = GIÁ BÁN trong sheet, PicURL đủ).
- Smoke-test Soho Home: `node scripts/smoke-soho.mjs` — ingest 3 sản
  phẩm Soho thật qua API, chia nhóm, xuất CSV theo template 20563.

## Deploy Cloudflare (từng bước)

Chuẩn bị: tài khoản Cloudflare, tên miền riêng (vd
`https://csv.tencongty.com`).

1. **Tạo D1 + apply migration:**
   ```bash
   npx wrangler d1 create csv-ebay-studio
   # lấy database_id từ output, điền vào wrangler.toml
   npx wrangler d1 migrations apply csv-ebay-studio
   ```
2. **Deploy Pages:**
   ```bash
   npx wrangler pages deploy public --project-name csv-ebay-studio
   # hoặc nối repo GitHub vào Cloudflare Pages, build output dir: public
   ```
   Gắn tên miền riêng cho Pages project.
3. **Secrets — KHÔNG commit `.dev.vars` hay khóa vào repo:**
   ```bash
   npx wrangler pages secret put <TÊN_SECRET>
   ```
   Khóa crawl `csvk_...` **không** đặt ở đây — nó nằm trong bảng
   `api_keys` của D1, tạo trong web ở tab Khóa crawl.
4. **Cloudflare Access — tạo 2 application** (làm trên dashboard, không
   có trong `wrangler.toml`):
   - **App chính:** bảo vệ toàn bộ site (`https://csv.tencongty.com/*`),
     chỉ email team mới vào được.
   - **App Bypass:** chỉ cho đường `/api/ingest/*` đi qua không cần đăng
     nhập Access (extension và crawler tự xác thực bằng Bearer `csvk_...`).
     Thiếu app này, extension báo "Tool chặn extension ở bước đăng nhập".
5. **Rate Limiting** (dashboard: Security → WAF → Rate limiting rules):
   vd 60 request/phút cho mỗi IP trên `/api/ingest/*`.
6. **Kiểm tra:**
   ```bash
   curl -s https://csv.tencongty.com/api/ingest/ping
   # expect: JSON 401 khi không có khóa
   curl -s -H "Authorization: Bearer csvk_..." https://csv.tencongty.com/api/ingest/ping
   # expect: {"name": "<tên khóa>"}
   ```

## Dùng push-crawl

```bash
# Đẩy file JSON records (dạng {records:[...]} hoặc [...]) lên tool:
node scripts/push-crawl.mjs crawl.json --endpoint https://csv.tencongty.com --key csvk_...
# Mặc định endpoint http://localhost:8787; khóa cũng lấy từ env CSV_STUDIO_KEY,
# endpoint từ env CSV_STUDIO_ENDPOINT. Xem scripts/push-crawl.mjs.
```

Script tự chia lô 1,5 MB / 200 bản ghi, giữ mọi bản ghi của một sản phẩm
trong cùng một lô. Mỗi crawler một khóa riêng (GitHub Actions: để khóa
trong Secrets). Chạy theo lịch: cron trên máy crawler hoặc GitHub Actions.

## Checklist P0 còn thiếu — KHÔNG thể tự làm

Những việc này cần người / tài khoản / dữ liệu thật, không nằm trong code:

- [ ] **Tên miền riêng** cho tool (vd `csv.tencongty.com`) + tài khoản
      Cloudflare để deploy theo mục trên.
- [ ] **Template eBay thật** để nạp và kiểm cột CSV (đặc biệt cột
      Relationship details khi có tuỳ chọn thứ ba
      `Size=S|Color=Black|Height=Regular`).
      Đã có template **20563 (gối/cushion)** — cần thêm template các danh
      mục khác (thảm, đèn, bàn ghế...) và **upload thử 1 file theo
      template 20563 lên Seller Hub** để xác nhận eBay nhận đúng.
- [ ] **Upload thử 5 sản phẩm OGL Move lên Seller Hub** (chế độ nháp
      hoặc tài khoản thử) để xác nhận eBay nhận đúng.
- [ ] ~~Dán link sheet Sabo_Lucky_Rate 9 để test tính năng dán link
      Sheet~~ — đã bỏ từ v9.2 (luồng dán link sheet không còn nữa);
      file sheet thật vẫn giữ làm dữ liệu tham chiếu
      (`~/workspace/user/files/Sabo_Lucky_Rate_9_Soho_Home.csv`).
- [ ] **File HTML Azazie / Eileen Fisher Minsu lưu** (Cmd+S, "Webpage,
      Complete", trang có ≥ 2 màu, ≥ 2 size, 1 biến thể hết hàng) — để
      viết reader Azazie và xác nhận Eileen Fisher có cùng cấu trúc
      Salesforce với Prana không.
- [ ] **Thử extension trên Chrome thật** với 8 site ở HANDOFF mục 4;
      ghi lại site nào đọc đủ biến thể, site nào bị chặn.
- [ ] **Web nhân sự thật của user (file/repo)** để nối tiếp — bản
      `public/` trong repo này chỉ là tham chiếu, không thay thế.
- [ ] Gọi AI thật end-to-end (cần key thật — user sẽ lấy key Gemini miễn phí ở Google AI Studio); gọi eBay Taxonomy thật.

## Quy tắc khi làm

- **Bí mật:** không commit khóa, token hay file `.dev.vars`. Secret chỉ
  đặt bằng `wrangler pages secret put`.
- **eBay:** tool chỉ tạo file. Không tự đăng lên eBay, không đổi tài
  khoản Production.
- **AI chỉ gợi ý:** người duyệt quyết định.
- **Crawl:** không vượt captcha hay chặn bot. Extension chạy trong Chrome
  thật của seller, gặp chặn thì báo lỗi.
- **Mỗi thay đổi luật** cần có test. Chạy `npm test` trước khi merge.
