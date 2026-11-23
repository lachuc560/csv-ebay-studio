# Tool lấy dữ liệu và điền template eBay — cập nhật 23/11/2026

Ưu tiên hiện tại là hoàn thiện tool. Web `public/` chỉ dùng thử quy trình; chưa nối hoặc deploy vào backend nhân sự.

Phạm vi: đọc thông tin sản phẩm → tra các trường theo Category ID eBay → điền dữ liệu có căn cứ → xuất CSV để đối chiếu. Thông tin shop để seller tự điền sau, không thêm quy trình cấu hình shop vào demo.

## Dùng bản mới

Giao diện **Tool lấy dữ liệu** có thanh điều hướng, bảng sản phẩm kèm ảnh và bộ lọc tìm theo tên/SKU/thương hiệu. Bộ lọc chỉ áp dụng cho bảng; công cụ hàng loạt vẫn xử lý toàn bộ kho. Các thẻ tổng quan dựa trên dữ liệu đã lưu. “Cần kiểm tra” phản ánh dữ liệu cơ bản, danh mục và cảnh báo nguồn; không thay thế kiểm tra đầy đủ trường listing khi xuất CSV. Giá nguồn hiển thị đúng tiền tệ.

1. Chạy `npm test`, rồi `npm run dev` trong thư mục dự án.
2. Mở `http://localhost:8787`. Tạo khóa crawl trong tab **Khóa crawl** nếu chưa có.
3. Cài/reload extension **1.3.7** từ thư mục `extension-v2/`. Bản ZIP nằm ở `dist/extension-v1.3.7.zip`. Nếu đã cài, mở `chrome://extensions`, bấm biểu tượng tải lại trên thẻ **CSV Studio Crawler**, rồi tải lại tab sản phẩm. Không cần cài thêm extension mới.
4. Mở trang sản phẩm, bấm **Crawl AI trang này**. Thiếu key AI vẫn đọc theo luật từ dữ liệu trang; cảnh báo cho biết phần chưa xác minh.
5. Trong tool, cấu hình eBay Developers **App ID + Cert ID** ở mục **AI & kết nối → eBay Taxonomy**, hoặc đặt `EBAY_APP_ID`, `EBAY_CERT_ID` trong `.env` rồi khởi động lại server. Không đặt key vào extension hoặc mã nguồn.
6. Vào **Xuất CSV eBay → Điền template theo danh mục**, chọn sản phẩm đã crawl, nhập mã danh mục và bấm **Tra mã & tải CSV**.
7. Tool xác minh đúng mã danh mục cuối (leaf), lấy item specifics, điền dữ liệu đã có và tự tải CSV. Nút **Tải lại CSV vừa tạo** nằm ngay phía trên bảng xem trước. Bảng hiển thị từng SKU và những mục cần sửa. Các trường shop để trống và được hiển thị riêng với lỗi dữ liệu sản phẩm. Nếu đang mở bản cũ, bấm **Ctrl+F5** để tải giao diện mới.

Nếu chưa biết Category ID, luồng **AI phân loại + xuất CSV theo nhóm** sẵn có vẫn tra gợi ý bằng từ khóa. Seller cần đối chiếu danh mục gợi ý có phù hợp sản phẩm. Tra được mã có thật không có nghĩa lựa chọn tự động luôn đúng loại sản phẩm.

**Category ID** là mã danh mục. **Item ID** là mã một listing; hai mã này không thay thế nhau. Taxonomy cung cấp danh mục và quy tắc item specifics, không trả một file CSV Seller Hub hoàn chỉnh. Tool sử dụng các cột chung của template CSV đã có, bổ sung các cột theo danh mục vừa tra và giữ nguyên dữ liệu nguồn để kiểm tra.

## Đã sửa trong lần cập nhật này

- Soho Home: mở **Details & Dimensions** và đợi tối đa 2 giây cho nội dung tải; đọc mô tả/thông số trong khối chi tiết, loại nút giao hàng/giỏ hàng và ảnh sản phẩm liên quan. Giữ màu khớp SKU và nhận trạng thái discontinued. Chưa đọc được thông số thì để trống.
- Gemini: khi model trả 404, tra ListModels và thử tối đa hai model Flash hỗ trợ tạo nội dung mà tài khoản được trả về. Không dùng model 2.0 cố định làm dự phòng. Cảnh báo phân biệt lỗi AI với chưa cấu hình khóa.
- eBay: dùng marketplace `EBAY_US`, tự chuẩn hóa cấu hình cũ `EBAY-US` cho Taxonomy và Browse.
- Giữ size, màu, tùy chọn thứ ba, SKU, UPC, ảnh, tiền tệ và tồn kho xuyên suốt extension → AI → kho sản phẩm.
- AI không thay tổ hợp SKU, bỏ bớt biến thể nguồn hoặc tự xác nhận tồn kho. Giá/ảnh/biến thể bị giới hạn có cảnh báo.
- Không đưa sản phẩm hết hàng hoặc tồn kho `null` vào CSV. Record nhập từ hệ thống cũ không có trường tồn kho vẫn giữ quy tắc tương thích cũ; crawler mới gửi `null` khi không biết.
- Không biến nguyên số GBP/EUR thành USD; sửa lỗi tính markup hai lần. Có thể chốt `edits.price` bằng tiền tệ listing hoặc cấu hình tỷ giá tường minh.
- Luồng xuất dữ liệu của demo dùng `allowIncompletePrice: true`: thiếu giá/tỷ giá vẫn giữ dòng sản phẩm, để trống StartPrice và báo lỗi theo SKU. Chế độ mặc định của core vẫn chặn giá không hợp lệ. Cả hai chế độ vẫn loại tồn kho hết hàng/chưa xác minh.
- Kiểm tra trường bắt buộc trên **từng dòng biến thể** thực sự được xuất. Một sản phẩm đầy đủ không che lỗi sản phẩm khác.
- Giữ đầy đủ danh sách giá trị và constraint eBay; kiểm tra giá trị chọn sẵn, độ dài, kiểu số, và điều kiện phụ thuộc khi API có trả. Không tự ghi `Unbranded` khi chưa biết thương hiệu.
- Lỗi một sản phẩm được ghi trong `skipped[].issues`; sản phẩm hợp lệ khác trong nhóm vẫn có file. File có `needsReview`, `validationIssues` và `missingAspects` để phân biệt việc đã tạo CSV với dữ liệu còn thiếu.
- Giữ chỉnh sửa seller khi crawl/upload ảnh chạy cùng lúc; lưu đồng thời cùng version trả HTTP 409 thay vì ghi đè.
- Build ZIP chạy được trên Windows, kiểm thử tự nhận các file `*.test.mjs` mới.
- CSV hiện xuất mỗi SKU thành một listing độc lập, đầy đủ tiêu đề/ảnh/mô tả. Chưa xuất một listing cha chứa nhiều biến thể. Khi có metadata danh mục đã xác minh, các cột item specifics bám theo danh mục đó, không giữ cột riêng của mẫu gối cho sản phẩm đèn.

## Kiểm chứng bằng file thật

Chạy `node scripts/export-sample.mjs <productId> <categoryId>` khi tool local đang chạy. Script đọc sản phẩm đã lưu, lấy metadata danh mục qua API local và dùng đúng `buildGroupedEbayCsvs` như giao diện. Kết quả nằm trong `exports/`, gồm `sample-<productId>-<categoryId>.csv` và báo cáo cùng tên với hậu tố `-check.md`, `-report.json`, `-category.json`. Báo cáo ghi giá trị đã điền, trường còn thiếu và lỗi chất lượng trong bản crawl cũ. Không sửa bản ghi sản phẩm và không đăng listing.

Mẫu kiểm tra dùng Remi Stone Table Lamp (`p_e9465c32c507f49f`), danh mục `112581 — Lamps`. File này dùng bản crawl đã lưu; bản sửa reader không tự làm mới nội dung cũ trong kho. Cần crawl lại để cập nhật các nhãn/mô tả đã sửa.

Kết quả ngày 20/11/2026: CSV có 1 SKU, 118 cột; điền 11/52 item specifics eBay trả về, gồm đủ 2 trường bắt buộc Brand và Type. Các cột riêng của gối đã được loại bỏ, cân nặng giữ đúng 14.8 lb. Đã đọc lại CSV bằng PowerShell ConvertFrom-Csv để đối chiếu độc lập SKU, cân nặng, số dòng/cột và 11 URL ảnh. Mẫu dùng giá tính theo cấu hình hiện có (543.99 USD từ giá nguồn 350 USD); các mặc định Quantity/Condition và hạn chế dữ liệu nguồn được ghi rõ trong báo cáo.

Mẫu Floria (`p_690b1ea4a78aa377`, danh mục `116880 — Wall Fixtures`) đã xuất thành công: 1 dòng sản phẩm, 120 cột, 2 URL ảnh. Giá nguồn 175 GBP được giữ trong dữ liệu nguồn; StartPrice để trống vì chưa có giá bán USD hoặc tỷ giá. Đã điền Brand và Material; còn thiếu Type bắt buộc. Mô tả bản crawl đã lưu có thông báo discontinued nên cần đọc lại nguồn để xác minh tồn kho trước khi listing. Đây là mẫu đối chiếu khả năng xuất dữ liệu, chưa phải file đủ điều kiện đăng bán.

## Giá nguồn và giá listing

Giá nguồn giữ nguyên tiền tệ. `edits.price` là **giá listing đã chốt**, không phải giá mua nguồn. Ví dụ cấu hình tính giá USD từ nguồn GBP:

```json
{
  "listingCurrency": "USD",
  "exchangeRates": { "GBP": 1.25 },
  "markupPct": 0.35,
  "ebayFeePct": 0.13,
  "shippingCost": 0,
  "roundTo99": true
}
```

`1.25` chỉ minh họa cách cấu hình, **không phải tỷ giá hiện hành**. Tool không tự tra tỷ giá. Có thể lưu cấu hình qua `PUT /api/config`. Demo không lấy thông tin shop từ cấu hình chung vào CSV; seller tự điền sau. Khi thiếu tỷ giá, CSV dữ liệu vẫn tải được với StartPrice trống; cần chốt giá bán hoặc cấu hình tỷ giá trước khi dùng file để listing.

## Các điểm dùng lại khi nối backend sau này

- `POST /api/ingest/extract-page`: extension gửi dữ liệu trang; bắt buộc `Authorization: Bearer csvk_...`. Cùng body/response với route web `/api/ai/extract-page`; chỉ nhánh `/api/ingest/*` được bypass Cloudflare Access.
- `POST /api/ingest/records`: nhập records; response thành công có thêm `partial` và `errors` để client biết bản ghi nào lỗi.
- `GET /api/ebay/categories/:id`: trả `{ ok, category }`, gồm danh mục đã xác minh, `requiredAspects`, `recommendedAspects`, các `aspectConstraint` và `aspectValues` từ eBay. Đây là route dành cho web nội bộ, không dùng khóa crawl.
- `PUT /api/products/:id`: gửi `version` và `edits`; xử lý HTTP 409 bằng cách tải lại sản phẩm, không tự ghi đè.
- `public/core.js`: `buildGroupedEbayCsvs`, `validateEbayTemplateProducts` là phần xử lý dùng lại, không phụ thuộc giao diện demo.

Tham chiếu chính thức: [eBay Taxonomy OpenAPI](https://developer.ebay.com/api-docs/master/commerce/taxonomy/openapi/3/commerce_taxonomy_v1_oas3.json), [quy tắc item specifics bắt buộc](https://www.developer.ebay.com/api-docs/user-guides/static/trading-user-guide/item-specifics-requirements.html).

## Kiểm chứng và giới hạn

Toàn bộ **360/360 kiểm thử đạt**, gồm kiểm thử giá trống, sự kiện tải CSV, tìm kiếm, bộ lọc và trạng thái dữ liệu; extension giữ bản 1.3.7. Đã kiểm tra trình duyệt ở khổ desktop và 390 px: tìm kiếm, mở/đóng chi tiết và cả sáu màn hình. Các test tự động dùng fixture/mô phỏng eBay, AI và R2; test HTTP local kiểm tra server thật. Kiểm tra API chính thức ngày 19/11/2026 bằng khóa được chủ máy cho phép đã xác nhận:

- Gemini tạo JSON thành công với `gemini-flash-lite-latest`; dữ liệu mẫu không có kích thước được giữ `null`.
- eBay xác thực thành công, trả cây danh mục Mỹ `0`, xác minh Category ID `20563` là **Pillows** và lấy item specifics. Kết quả lúc kiểm tra có hai trường bắt buộc **Type**, **Brand** và 31 trường khuyến nghị; luôn dùng dữ liệu API khi tra lại.
- R2: xác thực `HeadBucket` thành công (HTTP 200) với bucket đã cấu hình. Đã sửa thứ tự header khi ký upload SigV4 và kiểm thử chữ ký với dữ liệu mẫu độc lập; chưa upload ảnh thật để xác minh quyền ghi và URL công khai.

Chưa xác minh trực tiếp phần Details mới mở trên Chrome, chưa thử upload Seller Hub và chưa xác nhận toàn bộ website nguồn. Test kích thước dùng dữ liệu giả lập, không khẳng định kích thước thật của Tilney. File CSV cần seller kiểm tra danh mục, trường còn thiếu, chính sách shop và biến thể trước khi upload. Tool không đăng listing tự động.

Chẩn đoán chỉ đọc: `node scripts/check-services.mjs .env`. Thêm `--generate --category` để thử một lần tạo JSON từ dữ liệu mẫu và tra danh mục 20563; chỉ chạy khi chủ khóa cho phép gọi API. Script không in khóa, không tạo listing và không upload ảnh. `--gemini` cho phép kiểm tra khóa Gemini khi cấu hình provider chưa đúng; không dùng cờ này với khóa nhà cung cấp khác.

Kiểm tra truy cập bucket R2 mà không tạo object: `node scripts/check-r2.mjs .env`. HTTP 200 xác nhận truy cập bucket bằng khóa, chưa chứng minh quyền upload hay cấu hình URL công khai.
