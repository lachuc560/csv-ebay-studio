# Kiểm extension trên Chrome thật — phiếu test P0

> **Lưu ý từ v9.2 (16/11/2026):** phiếu này viết cho extension **v1.0.0**
> gốc (nút "Crawl trang này"). Extension hiện tại là **v1.3.0** — popup
> chỉ còn nút **"Crawl AI trang này"** (nút cũ đã bỏ), cài bằng cách
> Load unpacked thư mục `extension-v2/`. Nếu test bằng v1.3.0 thì bấm
> nút "Crawl AI trang này" thay cho "Crawl trang này" ở mục 2, và số
> test kỳ vọng là 224/224 (v9.2), không phải 38/38.

Ngày tạo: 13/11/2026. Dùng sau khi tải `csv-ebay-studio-v1.zip` về và giải nén.
Mục đích: kiểm bước P0-2 trong HANDOFF — extension v1.0.0 đọc đủ biến thể
trên trang thật của 8 site không, site nào bị chặn. Kết quả ghi vào bảng
mục 3 rồi gửi lại cho Muse để viết tiếp reader Azazie / Eileen Fisher.

> Chưa deploy Cloudflare thì test bằng server local — extension nối vào
> `http://localhost:8787`, không cần tên miền.

## 1. Chuẩn bị (5 phút)

```bash
cd csv-ebay-studio
npm test        # expect: 38/38 pass
npm run dev     # http://localhost:8787 — để cửa sổ này chạy
```

1. Mở `http://localhost:8787` → tab **Khóa crawl** → tạo 1 khóa, đặt tên
   vd `seller-test` → **copy khóa ngay lúc nó hiện một lần** (sau đó
   không xem lại được).
2. Chrome → `chrome://extensions` → bật **Developer mode** → **Load unpacked**
   → chọn thư mục `extension-v1.0.0/` trong bản vừa giải nén.
3. Mở popup extension → nhập Tool URL `http://localhost:8787` + khóa vừa
   tạo → ping hiện tên khóa là "Đã kết nối". Nếu báo chặn đăng nhập thì
   đó là lỗi Access — trên local không xảy ra, chỉ gặp khi đã deploy
   mà thiếu app Bypass `/api/ingest/*` (xem README mục Deploy).

## 2. Cách bấm thử mỗi site

Mở 1 trang chi tiết sản phẩm (không phải trang danh mục / tìm kiếm),
bấm **Crawl trang này** trong popup, ghi lại con số popup báo:
số biến thể, số còn hàng, số ảnh, cảnh báo tiền tệ / `price_estimated` /
`truncated`. So với những gì mắt thấy trên trang.

| Site | Kỳ vọng theo code đã audit | Chú ý khi test |
|---|---|---|
| OGL Move (Shopify) | Đủ: đúng giá/tồn từng biến thể, gồm tuỳ chọn thứ ba (vd Height) | Chọn sản phẩm có 3 tuỳ chọn để kiểm cột Relationship details |
| eBay | Đủ: đọc khối MSKU | — |
| Walmart | Đủ: đọc `__NEXT_DATA__` | Nếu báo "Bấm F5 để tải lại trang" thì F5 rồi bấm lại |
| AliExpress | Khá: tự bấm tối đa 150 lần, mỗi lần cách 450ms | Từ IP Việt Nam giá hiện VND — đổi trang sang USD trước khi bấm; nếu popup cảnh báo tiền tệ thì ghi lại |
| Prana | Chưa hoàn chỉnh: reader Salesforce chung `[data-attr]`, không có nhánh riêng | Ghi rõ màu/size nào đọc được, cái nào thiếu |
| Eileen Fisher | Chưa xác nhận có cùng cấu trúc Salesforce với Prana không | Đây là site cần kiểm kỹ nhất; nếu đọc sai thì lưu trang (mục 4) |
| Amazon | Thấp: mọi biến thể cùng giá đang chọn, tồn luôn `true`, gắn cờ `price_estimated` | Bắt buộc kiểm lại giá/tồn bằng tay trước khi xuất CSV |
| Azazie | Thấp: không có reader riêng, chỉ biến thể đang hiện, gắn cờ `price_estimated` | Đây là site ưu tiên mà extension đọc kém nhất; nếu thiếu biến thể thì lưu trang (mục 4) |

**Bẫy đã biết trước:** extension **không gửi record nào** nếu trang không
lấy được ảnh (lỗi "Không lấy được ảnh sản phẩm"). Dữ liệu Muse ngày
07/11 có 216 sản phẩm thiếu ảnh (Prana 43, Eileen Fisher 170, Azazie 3)
— các sản phẩm đó sẽ bấm lỗi qua extension cho tới khi có ảnh hoặc nới
luật này. Gặp lỗi đó thì ghi lại tên sản phẩm, đừng coi là site bị chặn.

**Nếu site chặn:** Azazie / Eileen Fisher / Prana / Amazon có thể chặn
trình duyệt tự động. Gặp captcha hoặc Access Denied thì dừng, ghi lại
"**bị chặn**" — không vượt captcha, không dùng thủ thuật qua mặt chặn bot.

## 3. Bảng ghi kết quả (điền rồi gửi lại cho Muse)

| Site | Link sản phẩm test | Biến thể đọc được / trên trang | Còn hàng | Ảnh | Tiền tệ | Cờ `price_estimated`? | Kết quả |
|---|---|---|---|---|---|---|---|
| OGL Move | | / | | | | | |
| eBay | | / | | | | | |
| Walmart | | / | | | | | |
| AliExpress | | / | | | | | |
| Prana | | / | | | | | |
| Eileen Fisher | | / | | | | | |
| Amazon | | / | | | | | |
| Azazie | | / | | | | | |

## 4. Nếu Azazie / Eileen Fisher đọc thiếu — lưu trang thật

Minsu đã lưu sẵn file HTML cho 2 site này; nếu bạn tự lưu thêm thì làm
đúng chuẩn HANDOFF để viết reader được:

- Chọn sản phẩm có **≥ 2 màu, ≥ 2 size, 1 biến thể hết hàng**.
- Chrome → `Cmd/Ctrl + S` → **Webpage, Complete** (lưu cả thư mục kèm theo).
- Gửi file HTML đó cho Muse (kèm link gốc của trang).

## 5. Sau khi test xong

- Sản phẩm đã crawl nằm trong web local, tab **Duyệt** — kiểm tuỳ chọn
  thứ ba có hiện trong bảng biến thể không.
- Muốn xuất CSV thử: tab **Xuất CSV** — nhưng **chưa upload lên eBay**
  cho tới khi có template eBay thật để đối chiếu (P0-4, xem README
  mục "Checklist P0 còn thiếu").
- Dữ liệu local chỉ trong bộ nhớ (`npm run dev` restart là mất) — đó là
  bản dev, chưa phải kho D1 trên Cloudflare.

## Nguồn

- Kỳ vọng từng site: `docs/extension-audit.md` mục 4, 6, 7 (audit code
  build sẵn, chưa kiểm trên trang thật).
- Contract ping/records, tab Khóa crawl, deploy: `README.md`.
- P0 trong HANDOFF 13/11: `~/workspace/user/files/HANDOFF.md` mục 6.
