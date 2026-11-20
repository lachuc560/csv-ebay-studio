# eBay Taxonomy API — tra mã danh mục thật từ eBay (v8)

## Vấn đề nó giải quyết

Trước v8, mỗi nhóm sản phẩm cần một file template eBay thật (tải từ Seller
Hub) mới xuất được file CSV upload được — nhóm chưa có template chỉ ra file
nháp DRAFT (Category + cột C: để trống). Với nhiều nhóm (đèn bàn, đèn tường,
đèn trần, gương, phòng tắm, ghế, bàn/tủ, áo choàng…) thì việc tải template
từng danh mục rất mất công, và user không thể nhớ hết mã danh mục (eBay có
hàng nghìn danh mục).

v8 nối **eBay Taxonomy API** — API chính thức của eBay để tra danh mục theo
từ khoá — để tool tự tra mã danh mục thật cho từng nhóm, kèm danh sách
trường bắt buộc/khuyến nghị (item aspects) của danh mục đó. Nhóm nào tra
được mã thì xuất file CSV upload được (Category = mã đã xác minh); nhóm nào
không tra được thì vẫn ra file nháp như v7, không bịa mã.

## Taxonomy API làm gì (đã xác minh từ tài liệu chính thức của eBay)

- Tài liệu: Taxonomy API Quick Start Guide (partnerhelp.ebay.com) và
  Taxonomy API OpenAPI (developer.ebay.com).
- Base URL: `https://api.ebay.com/commerce/taxonomy/v1`
  (sandbox: `https://api.sandbox.ebay.com/commerce/taxonomy/v1`).
- `GET /get_default_category_tree_id?marketplace_id=EBAY-US` — lấy mã cây
  danh mục của thị trường Mỹ (trả về tree id `0`).
- `GET /category_tree/0/get_category_suggestions?q=<từ khoá>` — gợi ý các
  danh mục theo từ khoá, kèm id + đường dẫn (vd "Home & Garden > Lamps >
  Table Lamps"). Tool chỉ nhận gợi ý là **leaf category**
  (`leafCategoryTreeNode=true`) — danh mục lá mới đăng bán được, danh mục
  cha thì không.
- `GET /category_tree/0/get_category_subtree?category_id=<id>` — kiểm tra
  một danh mục có phải lá không (khi eBay không trả cờ leaf trong gợi ý).
- `GET /category_tree/0/get_item_aspects_for_category?category_id=<id>` — các trường
  bắt buộc/khuyến nghị (aspect) của danh mục đó, kèm giá trị cho phép nếu
  eBay trả (vd Type, Brand, Material, Color…). Chỉ dùng cho **leaf category**.
  Lưu ý (v8.4): đừng nhầm với `get_item_aspects` — đường dẫn đó không tồn
  tại trong Taxonomy API, gọi sẽ bị eBay trả 404 (xem mục "Lỗi đã biết" ở
  cuối file).
- Xác thực: OAuth 2.0 **application token** (client credentials grant):
  `POST https://api.ebay.com/identity/v1/oauth2/token`, Basic auth = App ID
  (Client ID) + Cert ID (Client Secret), scope
  `https://api.ebay.com/oauth/api_scope`. Token có hạn ~2 giờ; tool tự
  cache trong RAM và làm mới trước khi hết hạn.

## Tạo tài khoản eBay Developers và lấy App ID + Cert ID

1. Mở https://developer.ebay.com → bấm **Sign in** (đăng nhập bằng tài
   khoản eBay thường — tài khoản dùng để bán hàng).
2. Vào **My Account** → **Create a keyset** (hoặc "Application Keys").
3. Điền tên app (vd "CSV Studio") → tạo xong sẽ thấy **App ID (Client ID)**
   và **Cert ID (Client Secret)** của môi trường **Production**.
   - Production dùng `api.ebay.com` — danh mục thật, dùng để đăng bán.
   - Sandbox dùng khóa riêng (tạo keyset Sandbox) và
     `api.sandbox.ebay.com` — chỉ để thử nghiệm, danh mục có thể khác
     production, không dùng để đăng bán thật.
4. Không cần xin quyền bán hàng (seller OAuth) cho Taxonomy API — chỉ cần
   application token, không cần đăng nhập lại tài khoản bán.

**Không gửi App ID / Cert ID trong chat** — chỉ dán vào ô nhập trong web
(tab "AI gợi ý" → mục eBay Taxonomy) hoặc đặt trong `.env` trên máy bạn.

## Cấu hình

Khóa được lấy theo thứ tự: biến môi trường `EBAY_APP_ID` + `EBAY_CERT_ID`
trước, rồi khóa dán trong web (chỉ RAM, mất khi restart server).

- Dev local: copy `.env.example` thành `.env`, điền `EBAY_APP_ID`,
  `EBAY_CERT_ID`, `EBAY_ENVIRONMENT` (để trống = production). Dev server tự
  load `.env` khi chạy `npm run dev`.
- Deploy Cloudflare: `npx wrangler pages secret put EBAY_APP_ID` và
  `npx wrangler pages secret put EBAY_CERT_ID` (và `EBAY_ENVIRONMENT` nếu
  cần sandbox).
- Trong web: tab "AI gợi ý" → mục "eBay Taxonomy" → chọn môi trường, dán
  App ID + Cert ID → **Lưu khóa eBay** → bấm **Kiểm tra kết nối** (gọi thử
  getDefaultCategoryTreeId — phải trả tree id 0 mới là OK).

Khóa không bao giờ được log, không trả ra response, không lưu vào file,
test hay zip.

## Luồng dùng (sau khi AI phân loại nhóm)

1. Tab **Duyệt** → bấm **AI phân loại + xuất CSV theo nhóm** (như v6/v7).
2. Bảng tóm tắt nhóm hiện thêm cột **Mã eBay**: nhóm gối hiện `20563 — đã
   có template gối`; nhóm đã tra mã từ lần trước hiện mã + đường dẫn +
   huy hiệu **đã xác minh từ eBay**; nhóm chưa có mã hiện "chưa có mã —
   file nháp" kèm nút **Tra mã eBay**.
3. Bấm **Tìm lại mã eBay cho nhóm chưa có mã** (hoặc nút **Tìm lại** của
   từng nhóm) → server gọi Taxonomy API, bảng kết quả hiện mã + đường dẫn
   + trường bắt buộc của từng nhóm. **Mã đã xác minh được TỰ ÁP luôn vào
   mọi sản phẩm của nhóm** (PUT kèm version check 409) — từ v9.3 không
   còn nút "Áp dụng mã" nào, không còn bước tay nào ở giữa.
4. Nhóm nào đã có mã (tự áp xong) thì xuất file CSV upload được, tên
   `ebay-<categoryId>-<groupKey>.csv`, Category = mã đã xác minh.
   - Nhóm nào chưa tra được mã thì vẫn ra file nháp DRAFT, không xuất nhầm.
   - Mã do AI đoán (`draftCategorySuggestion`) KHÔNG BAO GIỜ được tự áp
     hay ghi vào cột Category. (Luồng 1 nút "Lấy từ Sheet và xuất CSV"
     đã bỏ từ v9.2.)
5. File upload được: các cột C: điền theo aspect names mà Taxonomy trả về
   — chỉ điền giá trị đã có từ sản phẩm/sheet/AI đã duyệt; giá trị chưa có
   thì để trống và liệt kê trong mục "còn thiếu trường bắt buộc" (team điền
   tay, không bịa). C:Type của danh mục đã tra mã được TỰ ĐIỀN từ v9.4:
   khớp tiêu đề với danh sách giá trị cho phép của chính danh mục đó
   (Taxonomy trả về qua getItemAspects) — chỉ điền khi khớp được 1 giá trị
   nằm trong danh sách, không khớp thì để trống + warning trong file nhóm.
   C:Type của template gối (22 giá trị của category 20563) KHÔNG dùng cho
   danh mục khác.
   Khối Info trong file cũng là của danh mục đã tra (v8.2): dòng "For
   categoryId: <mã đã tra>" + dòng "The required aspects are ..." lấy từ
   Taxonomy, KHÔNG còn các dòng Info của template gối 20563. File gối
   (không có mã Taxonomy) vẫn giữ nguyên các dòng Info thật của 20563.

## Hai nguồn mã — phân biệt rõ

| Nguồn | Ghi vào cột Category? | Dùng để xuất file upload được? |
|---|---|---|
| **verifiedFromEbay** — mã lấy từ Taxonomy API (đã xác minh, tự áp từ v9.3) | Có | Có |
| Mã từ template thật user nạp vào | Có | Có |
| Gợi ý tên danh mục của AI (v7, `draftCategorySuggestion`) — chưa xác minh | **Không bao giờ** | Không |

Quy tắc an toàn trong code (`public/core.js`): `buildGroupedEbayCsvs`
chỉ xuất file upload được khi nhóm có `resolvedCategory.verifiedFromEbay`
hoặc `categoryId` khớp template đã nạp; mã do AI đoán không đi qua đường
nào để vào cột Category.

## Endpoint server (mới trong v8)

| Endpoint | Mô tả |
|---|---|
| `GET /api/ebay/status` | Trả `{configured, marketplace, environment, source}` — không trả key. |
| `POST /api/ebay/config` | Body `{appId, certId, environment}` — lưu khóa vào RAM (chỉ server). |
| `DELETE /api/ebay/config` | Xoá khóa đã dán trong web (khóa trong env vẫn còn). |
| `GET /api/ebay/check` | Gọi thử getDefaultCategoryTreeId — kiểm tra kết nối eBay. |
| `GET /api/ebay/category-suggestions?q=<từ khoá>` | Proxy có kiểm chứng: chỉ trả leaf category `{id, name, path}`, tối đa 10, cache theo từ khoá trong RAM. |
| `POST /api/ebay/resolve-groups` | Body `{groups: [{groupKey, label, sampleTitles[]}]}` — trả cho mỗi nhóm `{groupKey, categoryId, categoryName, categoryPath, verifiedFromEbay: true, requiredAspects[], suggestedAspects[]}` hoặc `{categoryId: null, warning}`. |

## Browse API — tự động tìm listing eBay khớp + số liệu BÁN/XEM (v9.1)

Cùng khóa eBay (App ID + Cert ID) đã cấu hình cho Taxonomy — Browse API
dùng application token (client credentials grant) giống Taxonomy, KHÔNG
cần seller consent hay user token. Code: `server/ebay-browse.mjs`
(chung token/baseUrl/fetchFn với `EbayTaxonomyRuntime`).

- **Tìm listing khớp:** `GET /buy/browse/v1/item_summary/search?q=<tên
  sản phẩm>` (tối đa 10 ứng viên) → chấm điểm từng ứng viên theo độ
  trùng tiêu đề + gần giá bán lẻ; ứng viên không chứa từ PHÂN BIỆT nào
  (vd "Daxton") thì điểm = 0; chỉ nhận điểm ≥ 0,50, không đạt thì KHÔNG
  gán bừa (trả `matched: false` + warning).
- **Lấy số liệu:** `GET /buy/browse/v1/item/{item_id}` trả `watchCount`
  (số người theo dõi) và `estimatedAvailabilities[].estimatedSoldQuantity`
  (số đã bán ƯỚC TÍNH — eBay nói rõ đây là ước tính, không phải số chính
  xác tuyệt đối). Sửa tay mã item thì dùng
  `GET /buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=<id>`.
  RIÊNG `GET /item` (getItems bulk) là limited-release chỉ dành cho đối
  tác chọn lọc nên KHÔNG dùng. Mọi gọi Browse API cần header
  `X-EBAY-C-MARKETPLACE-ID: EBAY-US`.
- **Đã kiểm chứng trong tài liệu chính thức của eBay trước khi code
  (16/11/2026):** trang Browse API getItem ghi "All methods in the
  Browse API require an Application access token, which is obtained
  using the client credentials grant flow"; trang Item type ghi rõ có
  field `watchCount` và `estimatedAvailabilities` ("it is impossible to
  return the exact quantity. So instead of returning quantity, the
  estimated availability of the item is returned").
- **Giới hạn:** khoảng 5.000 calls/ngày (search + getItem = 2
  calls/sản phẩm); bulk enrich giãn 200ms/sản phẩm, gặp 429 thì dừng +
  `stopped429`. Số liệu là TỔNG cả listing, không chia theo màu/size.
  KHÔNG cào WatchCount (robots.txt cấm bot, không có API công khai).
- **Endpoint server (mới trong v9.1):** `POST /api/ebay/enrich
  {productId, ebayItemId?}` và `POST /api/ebay/enrich-all
  {productIds?}`; `POST /api/ai/extract-page` tự chạy enrich sau khi
  lưu sản phẩm và trả thêm `enrichment`. Test:
  `tests/ebay-browse.test.mjs` (mock fetch, KHÔNG gọi eBay thật).

## Giới hạn gọi API và lưu ý

- eBay giới hạn số request theo app (xem "Application Keys" trong tài
  khoản Developers — thường đủ cho việc tra mã theo nhóm vì tool cache
  kết quả theo từ khoá trong RAM và gọi 1 lần cho mỗi nhóm, không gọi
  lại cho từng sản phẩm). Gặp 429 thì server trả lỗi rõ, không crash.
- **Mã danh mục eBay có thể thay đổi theo thời gian** (eBay thêm/bỏ/đổi
  danh mục theo mùa): mã đã lưu trong `edits.ebayCategoryId` là mã tại
  thời điểm tra. Trước khi upload lô lớn sau một thời gian dài, bấm
  "Tìm lại mã eBay cho nhóm chưa có mã" để tool kiểm tra lại mã với eBay.
- Taxonomy API chỉ tra mã + trường — không thay Seller Hub: vẫn cần điền
  Location / DispatchTimeMax / ReturnsAcceptedOption + 3 Profile của shop
  trước khi upload (như file gối 20563), và vẫn nên upload thử 1 dòng để
  kiểm tra Brand có được nhận không.
- Extension không thay đổi về Taxonomy: không có khóa eBay trong
  extension, Taxonomy chỉ chạy trong web qua server.

## Test

`tests/ebay-taxonomy.test.mjs` — mock fetch, KHÔNG gọi eBay thật: lấy
token + cache + tự làm mới khi hết hạn, token lỗi → lỗi rõ không crash,
getCategorySuggestions chỉ nhận leaf, resolve-groups cho 3 nhóm mẫu (đèn
bàn → mã giả lập, gương → mã giả lập, nhóm lạ → null + warning),
getItemAspects trả required aspects, xuất CSV upload được cho nhóm có mã
Taxonomy, mã do AI đoán không lọt vào cột Category, không có khóa eBay →
fallback file nháp như v7, khóa không lộ trong response/status/log.

## Lỗi đã biết

- **v8.4 — sai đường dẫn lấy trường danh mục (đã sửa):** v8–v8.3 gọi
  `GET /category_tree/0/get_item_aspects?category_id=<id>` để lấy trường
  bắt buộc/khuyến nghị của danh mục, nhưng đường dẫn này KHÔNG tồn tại
  trong Taxonomy API của eBay — eBay trả 404 cho mọi lần gọi. Đường dẫn
  đúng là `GET /category_tree/0/get_item_aspects_for_category?category_id=<id>`
  (chỉ dùng cho leaf category). Triệu chứng user gặp 16/11/2026: "Kiểm tra
  kết nối" OK (tree id 0) nhưng "Tra mã cho tất cả nhóm" trả 0/7 nhóm có
  mã. Đừng nhầm với `fetch_item_aspects` — đó là method lấy trường của
  TẤT CẢ leaf category trong 1 lần gọi (file >100MB), không phải method
  theo từng danh mục.

- **v9.4 — C:Type luôn trống ở danh mục đã tra mã (đã sửa):** `mapEbayType`
  chỉ khớp 22 giá trị của template gối 20563; đường xuất cho danh mục khác
  bỏ qua nó và điền Type qua `aspectFromProduct`, mà AI trích xuất + reader
  trang đều không sinh trường Type nên luôn trống. Ngoài ra các hàm
  `applyTaxonomyResolutions` / `autoApplyEbayResolutions` /
  `resolvedCategoryFromEdits` chỉ giữ tên aspect, làm mất danh sách giá trị
  cho phép (`values`) mà Taxonomy trả về. Triệu chứng user gặp 16/11/2026:
  dòng đèn "Fleur Table Lamp, US" danh mục 19591 đã tự áp mã OK nhưng cột
  *C:Type bắt buộc trống. Từ v9.4, `values` được giữ nguyên qua cả chuỗi
  (dạng `{name, values[]}`) và C:Type được khớp theo danh sách đó
  (`mapResolvedCategoryType` trong `public/core.js`) — xem mục 5 ở trên.
  File mẫu chứng minh: `examples/ebay-19591-fleur-table-lamp-SAMPLE.csv`.
