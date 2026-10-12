# Điểm danh khóa học AI – Futurework

Web điểm danh cho khóa học AI dành cho giảng viên (TUAF, TUEBA), dùng trong dự án RCT phase-in 2 đợt.

- **Trang điểm danh:** https://buiducthinh4869.github.io/diemdanh-futurework/
- **Backend:** Google Apps Script Web App gắn vào một Google Sheet (URL nằm trong `config.js`).
- **Google Sheet của dự án:** liên kết được lưu trong `DEPLOY_LOG.md` (file nội bộ, không đưa lên GitHub). Repo này công khai nên **không** ghi link Sheet, khóa quản trị hay danh sách học viên ở đây.

## Cách hoạt động

| | |
|---|---|
| Múi giờ | `Asia/Ho_Chi_Minh`; **mọi** kiểm tra ngày, giờ, trùng lặp đều do server làm, không tin giờ điện thoại |
| Đợt 1 | 10/10/2026 – 10/11/2026 (tính cả hai đầu) |
| Đợt 2 | 14/11/2026 – 14/12/2026 (tính cả hai đầu) |
| Giờ mở | `[08:00, 17:00)` trong các ngày thuộc một đợt; ngoài ra trang chỉ hiện thông báo, không có ô tìm kiếm |
| Điểm danh | Tối đa 1 lần/người/ngày (khóa `Ngày + ID`), không phân buổi sáng/chiều, không có mã buổi học |
| Đi sai đợt | Vẫn được ghi nhận, kèm cờ `Dung dot = 0` và dòng lưu ý trên màn hình |
| Tổng hợp | Tự động 19:00 hằng ngày (Apps Script chạy trong khung 19:00–20:00) |

Người dùng tìm tên (không phân biệt hoa/thường và dấu; gõ tên, họ, mã `TUAF0012`…), chọn bằng phím ↑ ↓ + Enter hoặc chạm, xem thẻ thông tin rồi xác nhận. Người chưa có tên trong danh sách bấm *“Không tìm thấy tên của bạn?”* để tự điền (cần Họ tên, Trường, Khoa, Đợt học); hệ thống tạo mã `TUAF-N001`, `TUEBA-N001`… và điểm danh luôn.

## Cấu trúc Google Sheet

| Tab | Nội dung |
|---|---|
| `DanhSach` | Danh sách chủ (331 người gốc + người tự đăng ký), có `study_arm`, `Nguồn`, `ten_khong_dau` |
| `TuDangKy` | Người tự đăng ký (có số điện thoại) |
| `Log` | Mọi lượt điểm danh của mọi ngày (dạng dài) để phân tích bằng Stata/Python: `Timestamp, Ngay, ID, Ho ten, Truong, Khoa, Bo mon, Dot dang ky, Dot hien hanh, Dung dot (1/0), study_arm, Nguon, Ghi chu` |
| `DD_yyyy-MM-dd` | Điểm danh trong ngày, ghi thời gian thực (cùng cột với `Log`) |
| `TH_yyyy-MM-dd` | Tổng hợp của ngày: A) số liệu tổng, B) đi sai đợt, C) vắng mặt, D) tự đăng ký |
| `TongHop_LuyKe` | Mỗi người một dòng: số buổi có mặt đúng đợt, số buổi đáng lẽ phải đi, tỷ lệ chuyên cần, số buổi đi sai đợt |

> Múi giờ của Google Sheet phải là `Asia/Ho_Chi_Minh` (hàm `setup()` tự đặt). Nếu lệch, Sheets sẽ diễn giải ngày/giờ sai vài giờ.

## Chạy bù tổng hợp một ngày

Trong trình soạn thảo Apps Script: chọn hàm `buildDailySummary` rồi gọi với tham số, hoặc qua web (cần `ADMIN_KEY`):

```
<WEB_APP_URL>?action=adminSummary&key=<ADMIN_KEY>&date=2026-10-12
```

Chỉ tạo `TH_` khi ngày đó thuộc một đợt **và** có ít nhất 1 lượt điểm danh; chạy lại sẽ ghi đè. Bước này cũng tự bù các dòng thiếu trong `Log` (xem *Hạn chế*).

## Hàm quản trị

Gọi qua web (GET hoặc POST JSON), đều cần `key=<ADMIN_KEY>` (lưu trong *Cài đặt dự án → Thuộc tính tập lệnh*). Cũng có thể chạy trực tiếp các hàm cùng tên trong trình soạn thảo (không cần khóa).

| Hành động | Tham số | Tác dụng |
|---|---|---|
| `adminCheckin` | `date`, `id` | Điểm danh bù cho một người (ghi chú `admin`) |
| `adminDelete` | `date`, `id` | Xóa một lượt điểm danh (cả `DD_` và `Log`) |
| `adminSummary` | `date` | Chạy bù tổng hợp |
| `adminResyncLog` | `date` | Bù các dòng `Log` còn thiếu so với `DD_` |
| `adminExport` | `sheet` (mặc định `DanhSach`) | Xuất một tab dạng JSON (`DanhSach`, `TuDangKy`, `Log`, `TongHop_LuyKe`, `DD_…`, `TH_…`) |
| `adminDeleteDay` | `date`, `confirm=yes` | Xóa toàn bộ điểm danh của một ngày (dọn dữ liệu thử) |
| `adminDeleteTab` | `name` | Xóa tab `TH_…` hoặc `DD_…` |
| `adminRemovePerson` | `id` (dạng `TUAF-N001`) | Xóa hẳn một người tự đăng ký khỏi mọi tab, đặt lại bộ đếm |
| `adminRebuild` | – | Tính lại `TongHop_LuyKe` |
| `adminClearCache` | – | Xóa bộ nhớ đệm (sau khi sửa tay `DanhSach`/`DD_`) |
| `adminSetup` | – | Chạy lại `setup()` (an toàn, không trùng dữ liệu) |
| `adminDebug` | – | Danh sách tab, múi giờ, trigger, bộ đếm |

### Giờ giả lập (chỉ để kiểm thử)

- Toàn hệ thống: `testMode('2026-11-12 10:00')` trong trình soạn thảo (hoặc `adminFake&value=...`); tắt bằng `testMode('')`. Khi bật, trang hiện cảnh báo “CHẾ ĐỘ THỬ NGHIỆM”.
- Từng yêu cầu: thêm `fake=2026-12-10 10:00&key=<ADMIN_KEY>` vào yêu cầu; **không** ảnh hưởng người dùng khác (nên dùng cách này).

## Sửa code và deploy lại (giữ nguyên URL)

Cần `clasp` (`npm i -g @google/clasp`, `clasp login`) và file `apps-script/.clasp.json` (không có trên GitHub).

```
cd apps-script
clasp push -f
clasp deploy -i <deploymentId> --description "mô tả"     # giữ nguyên URL Web App
```

`<deploymentId>` xem bằng `clasp list-deployments` (dòng không phải `@HEAD`). Sau khi deploy có thể mất vài giây để các phiên bản lan truyền.

`apps-script/RosterData.gs` (danh sách học viên, `SHEET_ID`, `ADMIN_KEY_SEED`) **không** nằm trên GitHub. Tạo lại từ 2 file Excel:

```
set FW_SHEET_ID=<id Google Sheet>          # lần đầu
python prepare_roster.py                   # kiểm tra 331 người, đối chiếu số lượng, ghi RosterData.gs
```

## Xuất dữ liệu

```
set FUTUREWORK_ADMIN_KEY=<ADMIN_KEY>
python export_danhsach.py                  # -> DanhSach_YYYY-MM-DD.xlsx (đọc URL từ config.js)
```

Với `Log` (để phân tích): mở Google Sheet → tab `Log` → *Tệp → Tải xuống → CSV*, hoặc `adminExport&sheet=Log`.

## Hạn chế cần biết

- **Danh sách học viên được phát công khai trong giờ mở** (cần để tìm kiếm trên điện thoại), gồm cả năm sinh và ghi chú. Ngoài giờ, server từ chối. Ai biết URL đều có thể điểm danh hộ người khác (thiết kế không có mã buổi học).
- Khi hàng trăm người bấm cùng lúc, hệ thống xếp hàng (khoảng 1,6 người/giây) và giao diện tự thử lại; thử với 100 người cùng lúc: 100/100 thành công trong ~1 phút, không trùng. `Log` được ghi sau khi nhả khóa nên có thể thiếu 1–2 dòng tạm thời; chúng được bù tự động khi tổng hợp 19:00 hoặc bằng `adminResyncLog`. Nguồn chính xác trong ngày là `DD_`.
- Form tự đăng ký giới hạn 60 lượt/ngày (chống spam).
- **Chia sẻ Google Sheet:** nên đặt *Hạn chế* (chỉ người được mời). Ai sửa được Sheet đều mở được Apps Script gắn kèm và đọc `ADMIN_KEY`. Nếu nghi ngờ lộ khóa, đổi giá trị `ADMIN_KEY` trong *Thuộc tính tập lệnh*.

## Cấu trúc thư mục

```
index.html, style.css, app.js, search.js, config.js   giao diện (GitHub Pages)
apps-script/Code.gs, appsscript.json                  backend
apps-script/RosterData.gs                              (không có trên GitHub) dữ liệu + khóa
prepare_roster.py                                      gộp 2 file Excel -> RosterData.gs
export_danhsach.py                                     xuất DanhSach ra Excel
```
