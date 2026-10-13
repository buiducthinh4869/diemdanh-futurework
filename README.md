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
| `TH_yyyy-MM-dd` | Tổng hợp của ngày: A) số liệu tổng (có dòng *Có lớp hôm nay*), B) đi sai đợt, C) vắng mặt, D) tự đăng ký |
| `BC_dd-MM-yyyy` | Báo cáo cho lãnh đạo của ngày (xem bên dưới), tạo cùng lúc với `TH_` |
| `TongHop_LuyKe` | Mỗi người một dòng: số buổi có mặt đúng đợt, số buổi đáng lẽ phải đi, tỷ lệ chuyên cần, số buổi đi sai đợt |

> Múi giờ của Google Sheet phải là `Asia/Ho_Chi_Minh` (hàm `setup()` tự đặt). Nếu lệch, Sheets sẽ diễn giải ngày/giờ sai vài giờ.

## Trường “có lớp” trong ngày

Lớp học vào thứ Bảy/Chủ nhật và **mỗi trường học vào một ngày riêng**, không có lịch cố định. Quy ước duy nhất, dùng ở `TH_`, `BC_` và `TongHop_LuyKe`:

> Trường X **có lớp** vào ngày D khi và chỉ khi có ít nhất 1 lượt điểm danh của học viên thuộc trường X vào ngày D (tính cả người tự đăng ký và dữ liệu nhập bù).

- Người *đáng lẽ phải đi* ngày D = học viên thuộc **đợt hiện hành** và thuộc **trường có lớp** ngày D. Trường không có lớp thì không ai bị tính vắng; các chỉ tiêu vắng/tỷ lệ của trường đó ghi `–`.
- `TongHop_LuyKe`: *số buổi đáng lẽ phải đi* của một người = số ngày thuộc đợt của người đó mà trường của người đó có lớp.
- `TH_`/`BC_` chỉ được tạo khi ngày đó có ít nhất 1 lượt điểm danh của TUAF/TUEBA.
- Hệ quả cần lưu ý: một lượt điểm danh vào ngày thường (kể cả để thử) cũng làm trường đó “có lớp” hôm ấy; dọn bằng `adminDeleteDay`.

## Sheet báo cáo `BC_dd-MM-yyyy`

Mỗi ngày có lớp có thêm một sheet (ví dụ `BC_10-10-2026`), ghi **giá trị tĩnh** (không công thức/pivot), ghi đè khi chạy lại.

| Cột | Tên | Nội dung |
|---|---|---|
| A | `ID` | ID học viên (người tự đăng ký: `TUAF-N001`…) |
| B | `Ho_ten` | Họ và tên |
| C | `Truong` | `TUAF` / `TUEBA` |
| D | `Ngay_hoc` | Ngày học, dạng **chữ** `dd/MM/yyyy` |
| E | `Diem_danh` | `Y` có mặt, `N` vắng |
| F | `Dot` | Đợt đăng ký của học viên: `1` hoặc `2` (số) |

- **Khối 1**: mọi học viên thuộc đợt hiện hành của các trường có lớp (Y hoặc N). **Khối 2**: người có mặt nhưng không thuộc đợt hiện hành (luôn `Y`).
- Sắp xếp: Trường (TUAF trước) → Khối 1 trước Khối 2 → ID tăng dần (ID tự đăng ký xếp cuối). Dòng `N` được tô nền nhạt.
- Bảng đếm bên phải từ ô `N3` (`Truong` / `Count of Diem_danh`): số dòng `Y` của từng trường **có lớp** và `Grand Total` (tính cả người đi sai đợt).

## Chạy bù tổng hợp một ngày

Trong trình soạn thảo Apps Script: chọn hàm `buildDailySummary` rồi gọi với tham số, hoặc qua web (cần `ADMIN_KEY`):

```
<WEB_APP_URL>?action=adminSummary&key=<ADMIN_KEY>&date=2026-10-12
```

Tạo cả `TH_` lẫn `BC_` khi ngày đó thuộc một đợt **và** có ít nhất 1 lượt điểm danh; chạy lại sẽ ghi đè. Bước này cũng tự bù các dòng thiếu trong `Log` (xem *Hạn chế*) và tính lại `TongHop_LuyKe`.

## Nhập bù điểm danh (`adminImport`)

Dùng khi cần nhập lại các buổi đã học trước khi hệ thống chạy. Gửi POST JSON (cần `ADMIN_KEY`), chỉ gồm các lượt **có mặt**; vắng mặt được hệ thống tự suy ra:

```json
{ "action": "adminImport", "key": "<ADMIN_KEY>",
  "items": [ { "date": "2026-10-10", "id": "<ID học viên>" }, ... ] }
```

- Kiểm tra trước: nếu có ngày không thuộc đợt nào hoặc ID không có trong `DanhSach`, **cả lô bị từ chối và không ghi gì** (phản hồi `code: "invalid"` kèm danh sách dòng lỗi).
- Dùng `LockService`; bỏ qua lượt đã có (khóa *Ngày + ID*) nên chạy lại không bị trùng (`added` / `skipped` trong phản hồi).
- Mỗi lượt ghi vào `DD_yyyy-MM-dd` và `Log` với `Timestamp` để trống và `Nguon = Nhập bù`.
- Xong thì chạy `adminSummary` cho từng ngày để tạo `TH_`, `BC_` và cập nhật `TongHop_LuyKe`.
- Dữ liệu nhập bù là dữ liệu cá nhân: **không** đưa file nguồn lên GitHub (`*.csv` đã nằm trong `.gitignore`).

## Hàm quản trị

Gọi qua web (GET hoặc POST JSON), đều cần `key=<ADMIN_KEY>` (lưu trong *Cài đặt dự án → Thuộc tính tập lệnh*). Cũng có thể chạy trực tiếp các hàm cùng tên trong trình soạn thảo (không cần khóa).

| Hành động | Tham số | Tác dụng |
|---|---|---|
| `adminCheckin` | `date`, `id` | Điểm danh bù cho một người (ghi chú `admin`) |
| `adminDelete` | `date`, `id` | Xóa một lượt điểm danh (cả `DD_` và `Log`) |
| `adminSummary` | `date` | Chạy bù tổng hợp (`TH_` + `BC_` + `TongHop_LuyKe`) |
| `adminImport` | `items` = `[{date, id}]` | Nhập bù lượt điểm danh (xem *Nhập bù điểm danh*) |
| `adminResyncLog` | `date` | Bù các dòng `Log` còn thiếu so với `DD_` |
| `adminExport` | `sheet` (mặc định `DanhSach`) | Xuất một tab dạng JSON (`DanhSach`, `TuDangKy`, `Log`, `TongHop_LuyKe`, `DD_…`, `TH_…`, `BC_…`) |
| `adminDeleteDay` | `date`, `confirm=yes` | Xóa toàn bộ điểm danh của một ngày: `DD_`, `TH_`, `BC_` và các dòng trong `Log` (dọn dữ liệu thử) |
| `adminDeleteTab` | `name` | Xóa tab `TH_…`, `DD_…` hoặc `BC_…` |
| `adminRemovePerson` | `id` (dạng `TUAF-N001`) | Xóa hẳn một người tự đăng ký khỏi mọi tab, đặt lại bộ đếm, tính lại `TongHop_LuyKe` |
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
