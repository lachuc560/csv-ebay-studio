# AI gợi ý (v5) — gọi LLM thật phía server

AI chỉ **gợi ý** — phân loại + điền Type, điền item specifics từ mô tả/specs,
tối ưu title ≤80 ký tự. Bạn xem gợi ý rồi bấm **Áp dụng** mới lưu vào sản
phẩm. AI **không** quyết giá bán (dùng GIÁ BÁN trong sheet khi có), không
điền Location/Dispatch/Returns/Profile, không tự đăng lên eBay.

Chưa có key AI thì tool tự gợi ý theo luật (`ruleBasedSuggestion` trong
`server/ai.mjs`) và giao diện hiển thị rõ cờ `provider: 'rule-based'`.

## Lấy key ở đâu

### Gemini

1. Mở https://aistudio.google.com (Google AI Studio), đăng nhập tài khoản Google.
2. Bấm **Get API key** (hoặc **Create API key**) → tạo key cho project của
   bạn. Tool không kiểm tra tiền tố key. Kiểm tra model, quyền truy cập,
   quota và chi phí áp dụng cho project trong Google AI Studio.
3. Dán key vào ô nhập trong web (tab **AI gợi ý**) — xem mục Cấu hình bên dưới.
   **Không gửi key trực tiếp trong chat** — chỉ dán vào ô nhập trong web.

### OpenAI — trả phí

1. Mở https://platform.openai.com → **API keys** → **Create new secret key**.
   Key bắt đầu bằng `sk-`.
2. OpenAI tính phí theo token dùng (mỗi sản phẩm = 1 lần gọi, vài trăm
   token). Cần nạp tiền / gắn phương thức thanh toán trước khi key chạy được.
   Kiểm tra bảng giá hiện tại trên trang của OpenAI — tool không ghi giá cố
   định vì giá có thể đổi.

## Cấu hình key (key chỉ ở server, không bao giờ vào extension)

| Cách | Làm thế nào | Dùng khi nào |
|---|---|---|
| Dán trong web (tab **AI gợi ý**) | Chọn provider → dán key vào ô password → **Lưu key** | Thử nhanh 1 phiên. Key chỉ lưu trong **RAM server**, mất khi restart server. Không lưu localStorage, không đưa vào extension. |
| File `.env` (dev local) | Copy `.env.example` thành `.env`, điền `AI_API_KEY=...` (và `AI_PROVIDER` / `AI_MODEL` nếu cần), restart `npm run dev` | Dùng lâu dài trên máy dev. `.env` đã có trong `.gitignore`, không commit. |
| Wrangler secret (deploy Cloudflare) | `npx wrangler pages secret put AI_API_KEY` (và vars `AI_PROVIDER` / `AI_MODEL` / `AI_BASE_URL` nếu cần) | Deploy thật. Không ghi key vào `wrangler.toml` hay file nào trong repo. |

**Thứ tự ưu tiên key:** biến môi trường `AI_API_KEY` (`.env` / secret) trước,
rồi mới tới key dán trong web. Nút **Xoá key** trong web chỉ xoá key trong RAM;
nếu server đã có `AI_API_KEY` trong env thì key đó vẫn được dùng — xem trạng
thái ở tab AI gợi ý (ghi rõ nguồn key: `env` hay `web`).

Kiểm tra trạng thái: `GET /api/ai/status` trả
`{configured, provider, model, source}` — **không bao giờ trả key**. Đổi
provider/model/baseUrl: `POST /api/ai/config` với
`{provider, model, baseUrl, apiKey}`; xoá key trong RAM: `DELETE /api/ai/config`.

## Model Gemini và giới hạn khi gợi ý hàng loạt

Model mặc định trong code là `gemini-2.5-flash`; cấu hình model khác bằng
`AI_MODEL` hoặc form AI. Khi model trả HTTP 404, server gọi **ListModels**
(tối đa 3 trang), lọc model Flash có hỗ trợ `generateContent` và thử tối đa
2 lựa chọn thay thế. Ưu tiên model ổn định và Flash Lite; loại các model
chuyên ảnh/âm thanh. Toàn bộ lần gọi và phục hồi dùng chung timeout 20 giây.
Tool không cố định model dự phòng đã ngừng hỗ trợ. Model gọi thành công
được nhớ trong phiên server; `/api/ai/status` trả model thực tế, kèm
`configuredModel` nếu khác cấu hình ban đầu. HTTP 401/403/429 không kích hoạt
đổi model. Tham chiếu: [Google Models API](https://aistudio.google.com/api-reference/models).

Quota áp dụng theo **project, model và usage tier**, có thể gồm số request,
số token và giới hạn ngày. Xem quota hiện hành trong
[Google AI Studio](https://aistudio.google.com/rate-limit) và
[tài liệu rate limits](https://aistudio.google.com/docs/rate-limits).

- **Giãn cách mặc định:** các lần gọi Gemini tuần tự cách nhau ít nhất
  **4 giây**. Đây là cấu hình của tool, không bảo đảm mọi project tránh
  được HTTP 429. Thời gian hoàn tất còn phụ thuộc thời gian API trả lời.
- **Gặp HTTP 429:** sản phẩm hiện tại dùng gợi ý theo luật; giao diện dừng
  lượt gọi hàng loạt và giữ kết quả đã có. Đợi 1 phút rồi thử lại. Nếu lỗi
  tiếp diễn, kiểm tra quota của model/project; giới hạn ngày không nhất
  thiết được giải quyết bằng cách chờ 1 phút. Khi chạy tiếp, sản phẩm đã
  có gợi ý được bỏ qua; bấm **Bỏ qua** gợi ý theo luật nếu muốn gọi AI lại.
- **Đổi nhịp gọi:** đặt `AI_MIN_INTERVAL_MS` (mili giây, `0` = không giãn)
  theo quota thực tế. OpenAI không giãn cách mặc định.

## AI phân loại nhóm + xuất CSV riêng từng nhóm (v6)

Khác với gợi ý từng sản phẩm (v5), v6 dùng AI để **gom nhóm**: LLM đọc
tên + mô tả + chất liệu/kích thước của nhiều sản phẩm rồi gom các sản phẩm
GIỐNG NHAU / cùng loại vào chung 1 nhóm — mỗi nhóm xuất 1 file CSV riêng.
Việc này sửa đúng điểm yếu của phân loại theo từ khoá: tên kiểu
"Soho Home Dax", "Mayfair" không chứa từ khoá loại nên trước đây rơi vào
nhóm Other, còn AI gom đúng nhờ đọc mô tả ("A decorative cushion…").

- **Endpoint:** `POST /api/ai/group` — body `{ productIds: [...] }`
  (lấy từ store) hoặc `{ products: [...] }` (gửi trực tiếp, vd từ
  extension/luồng Sheet). Trả `{ assignments: [{productId, groupKey,
  groupLabel, ebayType}], groups: [{key, label, categoryId, productIds,
  sampleTitles, count}], unclassified, warnings, provider, stopped429 }`.
  Tối đa 200 sản phẩm/lần gọi; LLM gom theo **batch 20 sản phẩm/lần gọi**,
  gọi tuần tự, giãn cách như gợi ý hàng loạt (Gemini mặc định ~4 giây/lần
  gọi). 117 sản phẩm = 6 batch; thời gian còn phụ thuộc phản hồi API/quota.
- **Kiểm chứng:** mỗi sản phẩm đúng 1 nhóm; productId lạ / thiếu sản phẩm
  / groupKey rỗng → nhóm `chua-phan-loai` (Chưa phân loại) + warning rõ,
  không tự đoán thay, không bỏ sản phẩm im lặng. `ebayType` chỉ trong 22
  giá trị cho phép khi nhóm là gối, nhóm khác thì `null` (không bịa).
  Các biến thể gối (throw-pillows, square-cushions…) gộp về `cushions`
  để cùng xuất 1 file theo template 20563.
- **Fallback + giới hạn 429:** không có key AI → nhóm theo từ khoá
  (`groupProductsByTheme`), cờ `provider: 'rule-based'`. LLM lỗi JSON /
  timeout 20s → batch đó fallback theo từ khoá + warning. Gặp 429 thì
  **dừng gọi LLM**, các batch còn lại dùng nhóm theo từ khoá, cờ
  `stopped429: true` để giao diện báo đợi 1 phút rồi bấm lại.
- **Lưu nhóm:** kết quả gom nhóm được lưu vào `product.edits.aiGroup` /
  `edits.aiGroupLabel` (+ `edits.ebayType` khi hợp lệ và chưa có Type đã
  duyệt) qua `PUT /api/products/:id` kèm version check 409 — để lần sau
  mở lại vẫn còn nhóm. `groupProductsByTheme` ưu tiên `edits.aiGroup`
  trước theme/từ khoá, nên mọi chỗ xuất CSV đều dùng đúng nhóm AI đã gom.
- **Xuất CSV riêng từng nhóm:** hàm `buildGroupedEbayCsvs` trong
  `public/core.js` (dùng chung cho web + `autoSheetToCsv` khi truyền
  `config.aiAssignments`). Mỗi file chỉ chứa đúng sản phẩm của
  nhóm đó — hiện chỉ nhóm gối xuất được (`ebay-20563-cushions.csv`) vì
  mới có template 20563; nhóm đèn/gương/phòng tắm/ghế/bàn… thì liệt kê rõ
  trong báo cáo là "chưa xuất được vì chưa có template", KHÔNG xuất nhầm
  sang template gối.
- **Dùng ở đâu:**
  - Web, tab **Duyệt**: nút **AI phân loại + xuất CSV theo nhóm** — hiện
    bảng tóm tắt các nhóm (tên nhóm + số sản phẩm + vài tên mẫu) TRƯỚC
    khi tải, rồi tự tải các file CSV từng nhóm xuống Downloads. Từ
    v9.3 nút này TỰ tra mã eBay + TỰ ÁP mã đã xác minh vào sản phẩm
    trước khi xuất (không còn nút "Áp dụng mã" nào, không còn bước tay
    nào ở giữa); nhóm chưa có mã vẫn ra file DRAFT + ghi rõ trong tóm
    tắt. Sau khi cào xong, chi tiết sản phẩm chỉ còn 1 danh sách gọn
    "Đã cào được" (tiêu đề, giá, ảnh, mô tả, chất liệu, kích thước, biến
    thể, listing khớp, đã bán, người theo dõi, mã danh mục — trường
    thiếu ghi "chưa có").
  - Extension v1.3.0 không gọi `/api/ai/group` — phân nhóm AI chạy
    trong web (tab Duyệt) sau khi sản phẩm đã về kho; chưa có key thì
    dùng nhóm theo từ khoá như cũ. (Luồng 1 nút Sheet → CSV đã bỏ từ
    v9.2, nên không còn đường gom nhóm bằng AI trong extension.)

## File CSV NHÁP riêng từng nhóm chưa có template (v7)

User còn rất nhiều sản phẩm khác và **không thể đưa hết template eBay
cho từng danh mục được** — hướng "đợi template từng nhóm" đã bế tắc.
v7 tự xoay bằng file nháp: mỗi nhóm chưa có template vẫn có 1 file CSV
riêng, dùng đúng cấu trúc 98 cột của template gối 20563 đã nhúng sẵn làm
mẫu cột (các cột chung của File Exchange là giống nhau), điền sẵn các cột
chung từ dữ liệu đã có, để trống Category + toàn bộ cột C: để team điền
nốt khi có template thật.

- **Hai loại file — đừng nhầm:**
  - **File upload được** — nhóm gối 20563, tên `ebay-20563-cushions.csv`,
    đủ Category + Type, đem upload lên Seller Hub được.
  - **File nháp** — nhóm chưa có template, tên bắt buộc có `DRAFT`, vd
    `ebay-DRAFT-table-lamps.csv`. Chưa điền Category nên **Seller Hub sẽ
    từ chối**, chỉ dùng để xem trước (Title, Description, giá, ảnh đã
    điền sẵn) và điền nốt. Tên file có DRAFT để không upload nhầm.
- **File nháp điền gì / trống gì:** điền sẵn Action=Add, Title (≤80),
  Description (đã làm sạch), StartPrice = GIÁ BÁN trong sheet khi có,
  Quantity=1, ConditionID=1000, Format=FixedPrice, Duration=GTC, PicURL
  (ảnh chính từ sheet/trang), CustomLabel (SKU/mã ACCOUNT). Để trống:
  Category, toàn bộ cột C: (Type, Brand, Color, Material, Size… — vì
  đó là item specifics riêng của danh mục trong template mẫu, ghi vào
  file nhóm khác là bịa dữ liệu), Location/Dispatch/Returns/Profile khi
  config chưa có. Hàm `draftMissingColumns` liệt kê đúng các cột còn
  trống để team điền.
- **Bố cục file nháp (v8.1):** v7 đã lỡ để nguyên khối dòng Info của
  template gối 20563 trong file nháp — mở file gương trong Excel vẫn thấy
  "For categoryId: 20563" và danh sách giá trị Type toàn loại gối. Từ
  v8.1, file nháp chỉ còn: dòng Version, dòng header 98 cột, ĐÚNG 1 dòng
  cảnh báo DRAFT ngay dưới header ("DRAFT — File nháp, chưa có mã danh
  mục eBay nên chưa upload được lên Seller Hub…"), rồi các dòng dữ liệu
  — không còn chuỗi "20563" hay dòng Info nào của gối trong file. File
  upload được (gối và nhóm đã có mã Taxonomy) giữ nguyên các dòng Info
  đúng của danh mục đó.
- **BOM UTF-8 + chống trùng sản phẩm (v8.3):** mọi file CSV xuất ra
  (file upload được, file nháp, `buildCsv` cũ) đều bắt đầu bằng BOM UTF-8
  (EF BB BF) để Excel trên Windows đọc đúng tiếng Việt — trước v8.3 file
  không có BOM nên dòng cảnh báo DRAFT vỡ thành "nhÃ¡p". URL khớp
  sheet↔crawl được chuẩn hoá (`normalizeProductUrl`: bỏ "/" cuối, query,
  fragment, "www.") nên cùng một sản phẩm không còn tách thành 2 bản ghi
  trùng id; lưới an toàn cuối cùng gộp các bản ghi trùng (cùng id + cùng
  URL sản phẩm) lúc xuất (`dedupeProductsById`, số dòng đã gộp ghi trong
  `stats.mergedDuplicateProducts`) — dữ liệu local đã có bản trùng vẫn
  xuất đúng 1 dòng mà không cần xoá tay. Chỉ so id là không đủ: 2 màu
  khác nhau của cùng slug (vd Vinnie Bisque/Sage) vẫn trùng id nhưng là
  2 sản phẩm khác nhau, không được gộp.
- **AI gợi ý danh mục cho file nháp:** endpoint `POST
  /api/ai/draft-categories` — body `{ groups: [{key, label, count?,
  sampleTitles?}] }`, 1 lần gọi cho tối đa 20 nhóm. LLM gợi ý thêm cho
  mỗi nhóm chưa có template: tên danh mục eBay có thể đúng (vd
  "Table Lamps") + các trường riêng nhóm đó thường cần (vd đèn cần
  "Bulb Type", "Wattage"). Chỉ ở dạng gợi ý text, lưu vào
  `edits.draftCategorySuggestion` kèm cờ `unverified: true`, HIỂN THỊ
  rõ là "AI đoán, chưa xác minh" — KHÔNG BAO GIỜ ghi vào cột Category
  hay C:Type của file nháp. Không có key AI thì bỏ qua phần này, file
  nháp vẫn tạo được từ dữ liệu sheet/trang. Gặp 429 / LLM lỗi → gợi ý
  rỗng kèm warning, không throw.
- **Dùng ở đâu:**
  - Web, tab **Duyệt**: nút **AI phân loại + xuất CSV theo nhóm** — kết
    quả chia 2 mục rõ ràng: (a) "File upload được" (nhóm gối, tự tải);
    (b) "File nháp — chưa upload được, cần điền Category" — mỗi nhóm 1
    nút tải file nháp + danh sách cột còn trống + gợi ý danh mục của AI
    (nếu có), kèm cảnh báo ngay chỗ nút tải.
  - Web, tab **Duyệt**: tải cả file nháp cho các nhóm chưa có template
    (kèm cảnh báo trong tóm tắt cuối), không chỉ tải file gối. (Luồng 1
    nút Sheet → CSV đã bỏ từ v9.2.)
  - Web, tab **Xuất CSV**: danh sách nhóm hiện file gợi ý là
    `ebay-DRAFT-<nhóm>.csv (nháp — chưa upload được)` cho nhóm chưa có
    categoryId.
- **Ví dụ với sheet thật (117 sản phẩm):** file gối 53 sp upload được;
  file nháp: đèn 39 sp (`ebay-DRAFT-lighting.csv`), phòng tắm 8,
  gương 7, ghế 3, giường 2, tủ 1 — tổng 60 sp trong 6 file nháp.
- **Biến file nháp thành file upload được:** tải template thật của danh
  mục đó từ Seller Hub 1 lần (Reports → Upload → Get template → chọn
  đúng danh mục) rồi nạp vào tool (tab Xuất CSV → chọn file template)
  — sau đó nhóm đó xuất file upload được như nhóm gối. Nối eBay Taxonomy
  API để tự lấy CategoryId + aspects thì đã làm trong v8 (mục "eBay
  Taxonomy" trong README): tra được mã thật từ eBay thì nhóm đó xuất file
  upload được luôn, không cần template thật.

## AI làm gì / không làm gì

| AI làm | AI không làm |
|---|---|
| Phân loại + điền Type khi tên không chứa từ khoá (vd "Soho Home Dax", "Mayfair") | Quyết giá bán — dùng GIÁ BÁN trong sheet khi có |
| Điền item specifics (Material, Color, Size, Room, Pattern, Style, Theme…) từ mô tả/specs | Tự bịa Brand — Brand luôn lấy từ sản phẩm/sheet (Soho Home) |
| Tối ưu title ≤80 ký tự, làm sạch mô tả | Điền Location / Dispatch / Returns / Profile |
| Gợi ý `ebayType` chỉ trong 22 giá trị cho phép của template 20563 | Tự áp dụng — phải bấm **Áp dụng** mới lưu |

## Kiểm chứng đầu ra (mọi gợi ý đều qua kiểm chứng trước khi trả về)

Code: `server/ai-providers.mjs` (`normalizeLlmSuggestion`) + `server/ai.mjs`
(`validateAiSuggestion`, `suggestFromProduct`).

- `ebayType` phải đúng 1 trong 22 giá trị cho phép của template 20563
  (hằng `EBAY_TYPES_20563` trong `public/core.js`, test đối chiếu 100% với
  template thật). LLM trả giá trị ngoài danh sách → `ebayType = null` +
  warning *"AI gợi ý Type ngoài danh sách cho phép — để trống, team tự điền"*,
  không tự đoán thay.
- Title cắt tối đa 80 ký tự (`truncateTitle`).
- Specifics chỉ nhận khía cạnh có trong template (`AI_SPECIFIC_ASPECTS`),
  giá trị rỗng thì bỏ; Brand do LLM bịa thì bị thay bằng Brand thật.
- LLM trả JSON lỗi / provider lỗi / timeout 20 giây → fallback về gợi ý theo
  luật kèm warning rõ lý do, route không crash.

## Áp dụng gợi ý

- Từng sản phẩm: tab **Duyệt** → bấm vào sản phẩm → **Gợi ý AI** → xem panel
  gợi ý (title / Type / specifics / warnings / nguồn LLM hay rule-based) →
  **Áp dụng** (ghi `edits.title`, `edits.ebayType`, `edits.aiSpecifics` qua
  `PUT /api/products/:id`, kèm version check 409) hoặc **Bỏ qua**.
- Hàng loạt: nút **Gợi ý AI hàng loạt** trong tab Duyệt — mỗi dòng có nút
  **Áp dụng** / **Bỏ qua** riêng.
- Khi xuất CSV theo template, `mapEbayType` ưu tiên `edits.ebayType` đã duyệt
  và `aspectFromProduct` ưu tiên `edits.aiSpecifics` đã duyệt.

## Số lần gọi và chi phí

- Gợi ý từng sản phẩm thường dùng 1 lần gọi LLM; phục hồi model khi gặp
  404 có thể phát sinh lần gọi thêm. Chi phí phụ thuộc model, lượng token
  và cấu hình tài khoản. Kiểm tra bảng giá hiện hành của nhà cung cấp.
- Gom nhóm gửi tối đa 20 sản phẩm trong một batch: 117 sản phẩm chia
  thành 6 batch thay vì 117 lượt gợi ý riêng. Ít request hơn không bảo đảm
  chi phí hoặc thời gian cố định vì mỗi batch chứa nhiều dữ liệu hơn.

## Crawl AI 1 trang (v9) — trích xuất trang sản phẩm bằng AI

Seller mở 1 trang sản phẩm trên web bán lẻ (Soho Home, Amazon...), bấm
**"Crawl AI trang này"** trong popup extension v1.2.0. Extension đọc dữ
liệu thô của trang (JSON-LD + biến thể + text hiển thị, tối đa ~12.000
ký tự) rồi gửi về `POST /api/ai/extract-page`; server trích xuất bằng
AI (cùng cấu hình Gemini/OpenAI của server; Gemini mặc định giãn 4s/lần)
rồi lưu thành sản phẩm trong tool. Không có key AI thì
trích xuất theo luật từ dữ liệu trang đã đọc + warning rõ. Chưa cấu
hình tool thì extension giữ bản copy local (`aiPagePending`).

AI trích xuất JSON: `{title, price, currency, images, description,
material, dimensions, variants: [{color, size, price, stock}]}`.

**Quy tắc chống bịa (server kiểm chứng trước khi trả về, code
`server/ai.mjs` — `normalizeAiExtractedPage`):**

- SIZE và MÀU lấy ưu tiên từ trang gốc. Màu/size LLM trả về phải khớp 1
  giá trị option của biến thể trên trang gốc (không phân biệt hoa/thường)
  hoặc xuất hiện trong text trang — không khớp → null + warning.
- Giá: chỉ nhận khi trang gốc có giá. LLM tự đưa giá khi trang không
  ghi giá → bỏ, null + warning. Giá biến thể phải khớp giá trên trang
  gốc hoặc bằng giá sản phẩm.
- Ảnh: chỉ giữ URL có trong dữ liệu trang gốc. LLM bịa URL ảnh → bỏ.
- Title cắt ≤80 ký tự; giá lấy giá non-member hiển thị trên trang
  (Soho Home: JSON-LD `offers.price`, KHÔNG lấy Member price).
- Trường nào trang không có thì null + warning, không bịa.

Gặp HTTP 429 (quota của nhà cung cấp): dừng gọi LLM,
các trang còn lại trong bulk dùng trích xuất theo luật, cờ
`stopped429` / `rateLimited` để giao diện báo đợi rồi thử lại. Nếu lỗi kéo
dài, kiểm tra quota của model/project tại nhà cung cấp.

### Số liệu eBay tham khảo (v9.1) — tự động qua Browse API, không vào file CSV upload

- **Tự động (luồng chính):** sau khi "Crawl AI trang này" lưu sản phẩm,
  server tự tìm listing eBay khớp qua Browse API (`search` theo tên +
  giá, chỉ nhận ứng viên điểm khớp ≥ 0,50) rồi `getItem` lấy `watchCount`
  (số người theo dõi) và `estimatedSoldQuantity` (số đã bán ƯỚC TÍNH).
  Popup hiện luôn listing đã khớp + 2 số liệu; tab Duyệt có nút "Tìm
  listing eBay cho tất cả sản phẩm chưa có số liệu" và nút "Tìm lại"
  từng sản phẩm.
- **Sửa tay khi khớp sai (tuỳ chọn nâng cao):** form chi tiết sản phẩm
  vẫn giữ ô nhập mã item eBay — nhập mã vào thì server lấy thẳng listing
  đó qua `get_item_by_legacy_id`, không cần dán số. Ô "Số người theo
  dõi" chỉ để sửa tay khi Browse API không trả watchCount.
- Tab Duyệt hiện thêm 3 cột **Đã bán (eBay)**, **Người theo dõi** và
  **Listing eBay khớp** (tên + điểm khớp); tab Xuất CSV có nút **"Xuất
  file research"** → 1 file riêng cho mỗi nhóm (`research-<nhóm>.csv`):
  Title, URL gốc, Giá bán lẻ, Giá bán eBay (GIÁ BÁN), Đã bán, Người theo
  dõi, CategoryId, Link listing eBay, Điểm khớp.
- **Giới hạn:** trang bán lẻ không có lượt bán/lượt xem; số đã bán là
  ƯỚC TÍNH của eBay (không phải số chính xác tuyệt đối); số liệu là
  TỔNG cả listing, không chia theo màu/size. WatchCount KHÔNG được cào
  (robots.txt cấm bot, không có API công khai) — v9.1 lấy số liệu thẳng
  từ Browse API của eBay, không qua WatchCount. Số bán/xem từng màu/
  từng size không tồn tại ở bất kỳ nguồn công khai nào — tool không bịa
  ra số đó.

### Ảnh trên Cloudflare (R2) (v9.1) — PicURL trong CSV là link Cloudflare

- Sau khi sản phẩm được lưu, server tự tải ảnh gốc rồi upload lên
  bucket R2 qua S3-compatible API (ký SigV4, không dependency ngoài),
  `product.images` đổi thành link Cloudflare, link gốc giữ trong
  `product.originalImages`. Key ảnh theo hash SHA-256 của URL gốc nên
  crawl lại không upload trùng.
- Chưa cấu hình R2 thì giữ link ảnh gốc + warning rõ, không chặn luồng.
  Cách tạo bucket + domain công khai + điền 5 biến
  `CLOUDFLARE_R2_*` (`.env` hoặc `wrangler pages secret put`): xem
  README.md mục "Ảnh trên Cloudflare (R2)" và `.env.example`.

## Chưa test được

- **Chưa có key thật nên chưa gọi LLM thật end-to-end** (chỉ test bằng mock
  fetch trong `tests/ai-providers.test.mjs`). Khi user có key Gemini miễn
  phí thì test thật: dán key trong web → bấm Gợi ý AI cho 1 sản phẩm
  (vd Daxton Square Cushion) → kiểm tra Type/specifics trả về, rồi mới
  bấm gợi ý hàng loạt.
- Bộ chọn "Configure" của Soho Home chưa xác nhận được từ text fetch
  (không liên quan AI).
