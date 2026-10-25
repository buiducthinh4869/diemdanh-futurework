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
| Giờ mở | Mặc định `[08:00, 17:00)`, admin có thể đổi tại `admin.html`; lịch riêng theo ngày ưu tiên hơn giờ mặc định. Chỉ mở trong các ngày thuộc một đợt; ngoài ra trang chỉ hiện thông báo, không có ô tìm kiếm |
| Điểm danh | Tối đa 1 lần/người/ngày (khóa `Ngày + ID`), không phân buổi sáng/chiều, không có mã buổi học |
| Đi sai đợt | Vẫn được ghi nhận, kèm cờ `Dung dot = 0` và dòng lưu ý trên màn hình |
| Tổng hợp | Tự động 17:00 hằng ngày (Apps Script chạy trong khung 17:00–18:00): `BC_`, `TongHop`, `ChuyenCan` |

Người dùng tìm tên (không phân biệt hoa/thường và dấu; gõ tên, họ, mã `TUAF0012`…), chọn bằng phím ↑ ↓ + Enter hoặc chạm, xem thẻ thông tin rồi xác nhận. Người chưa có tên trong danh sách bấm *“Không tìm thấy tên của bạn?”* để tự điền (cần Họ tên, Trường, Khoa, Đợt học); hệ thống tạo mã `TUAF-N001`, `TUEBA-N001`… và điểm danh luôn.

## Cấu trúc Google Sheet

Bốn tab cố định + **một** tab mỗi ngày học (cả khóa khoảng 19 ngày cuối tuần, nên Sheet chỉ có khoảng 25 tab):

| Tab | Loại | Nội dung |
|---|---|---|
| `DanhSach` | cố định | Danh sách học viên (master, sửa tay được), gồm cả người tự đăng ký. Cột: `ID học viên, Trường, Khoa, Đợt học, Họ và tên, Năm sinh, Giới tính, Ngạch giảng viên, Bộ môn, Ghi chú, study_arm, Nguồn` (`Danh sách gốc` / `Tự đăng ký`), `ten_khong_dau`, `So_dien_thoai`, `Ngay_dang_ky` |
| `Log` | cố định | **Nguồn dữ liệu gốc duy nhất**: mỗi lượt điểm danh 1 dòng. Cột: `Timestamp, Ngay, ID, Ho_ten, Truong, Khoa, Bo_mon, Dot_dang_ky, Dot_hien_hanh, Dung_dot, study_arm, Nguon` (`Web` / `Admin` / `Nhập bù`) |
| `TongHop` | cố định | Mỗi (Ngày, Trường có lớp) 1 dòng, cập nhật lúc 17:00, ngày mới nhất lên đầu |
| `ChuyenCan` | cố định | Mỗi học viên 1 dòng, cập nhật lúc 17:00, bật sẵn bộ lọc |
| `BC_dd-MM-yyyy` | mỗi ngày học | Báo cáo cho lãnh đạo của ngày (xem bên dưới) |

Thứ tự tab: `BC_` của ngày mới nhất, `TongHop`, `ChuyenCan`, `DanhSach`, `Log`, các `BC_` cũ hơn (ngày giảm dần), cuối cùng là tab ẩn. Tab lạ bất kỳ (ví dụ `DonVi`, `CanhBao`) bị **ẩn, không bị xóa**.

Điểm danh chỉ ghi vào `Log` (và `DanhSach` với người tự đăng ký): **không** tạo tab theo ngày lúc điểm danh. Kiểm tra trùng dựa trên `Log` (cặp `Ngay` + `ID`), có bộ nhớ đệm của hôm nay để không phải đọc lại cả `Log` mỗi lần, và vẫn nằm trong `LockService`.

`TongHop` — cột: `Ngay, Truong, Dot_hien_hanh, Tong_phai_di, Co_mat, Co_mat_dung_dot, Co_mat_sai_dot, Tu_dang_ky, Vang, Ty_le_co_mat_dung_dot, Treatment_co_mat, Control_co_mat, Control_di_dot1` (`Control_di_dot1` để trống ở ngày thuộc Đợt 2).

`ChuyenCan` — cột: `ID, Ho_ten, Truong, Khoa, Dot_dang_ky, study_arm, So_buoi_phai_di, So_buoi_co_mat, So_buoi_sai_dot, Ty_le_chuyen_can, Ngay_vang_gan_nhat`.

> Múi giờ của Google Sheet phải là `Asia/Ho_Chi_Minh` (hàm `setup()` tự đặt). Nếu lệch, Sheets sẽ diễn giải ngày/giờ sai vài giờ.

## Trường “có lớp” trong ngày

Lớp học vào thứ Bảy/Chủ nhật và **mỗi trường học vào một ngày riêng**, không có lịch cố định. Quy ước duy nhất, dùng ở `BC_`, `TongHop` và `ChuyenCan`:

> Trường X **có lớp** vào ngày D khi và chỉ khi có ít nhất 1 lượt điểm danh của học viên thuộc trường X vào ngày D (tính cả người tự đăng ký và dữ liệu nhập bù).

- Người *đáng lẽ phải đi* ngày D = học viên thuộc **đợt hiện hành**, thuộc **trường có lớp** ngày D và **đã có tên trong danh sách** vào ngày đó (người tự đăng ký sau ngày D không bị tính vắng ngày D, nên số liệu ngày cũ không đổi khi tổng hợp lại). Trường không có lớp thì không ai bị tính vắng.
- `ChuyenCan`: *số buổi phải đi* của một người = số ngày (đã có trong `TongHop`) thuộc đợt của người đó mà trường của người đó có lớp, tính từ ngày người đó có tên (người tự đăng ký: từ `Ngay_dang_ky`). `So_buoi_sai_dot` = số ngày người đó có mặt ở đợt khác đợt đăng ký.
- Chỉ tạo `BC_` và dòng `TongHop` khi ngày đó có ít nhất 1 lượt điểm danh của TUAF/TUEBA. Khi một ngày không còn lượt nào (ví dụ sau `adminDeleteDay`), `BC_` và các dòng `TongHop` của ngày đó bị gỡ.
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
- Sắp xếp: Trường (TUAF trước) → Khối 1 trước Khối 2 → ID tăng dần (ID tự đăng ký xếp cuối). Dòng `N` tô nền đỏ nhạt; dòng thuộc khối sai đợt tô nền vàng nhạt.
- Bảng đếm bên phải từ ô `N3` (`Truong` / `Count of Diem_danh`): số dòng `Y` của từng trường **có lớp** và `Grand Total` (tính cả người đi sai đợt).
- Bảng chỉ tiêu từ ô `N9`: `Phải đi (đúng đợt)`, `Có mặt đúng đợt`, `Có mặt sai đợt`, `Vắng`, `Tỷ lệ có mặt đúng đợt`; chỉ hiện cột của trường có lớp, cột cuối là `Tổng`.

## Tổng hợp lúc 17:00 và chạy bù

`buildDailySummary(dateStr)` (trigger 17:00 hằng ngày gọi cho hôm nay): đọc `Log` + `DanhSach`, xác định trường có lớp, rồi (1) tạo/ghi đè `BC_dd-MM-yyyy`, (2) ghi/ghi đè các dòng của ngày đó trong `TongHop`, (3) tính lại toàn bộ `ChuyenCan`, (4) sắp xếp lại tab.

Chạy bù trong trình soạn thảo Apps Script (hàm `buildDailySummary` với tham số) hoặc qua web (cần `ADMIN_KEY`):

```
<WEB_APP_URL>?action=adminSummary&key=<ADMIN_KEY>&date=2026-10-12
```

Sau khi sửa dữ liệu của một **ngày đã qua** bằng `adminCheckin` / `adminDelete` / `adminImport`, hệ thống tự gọi lại `buildDailySummary` cho ngày đó. Sửa tay trực tiếp `Log` thì chạy `adminSummary` cho ngày đó (và `adminClearCache` nếu sửa ngày hôm nay).

## Nhập bù điểm danh (`adminImport`)

Dùng khi cần nhập lại các buổi đã học trước khi hệ thống chạy. Gửi POST JSON (cần `ADMIN_KEY`), chỉ gồm các lượt **có mặt**; vắng mặt được hệ thống tự suy ra:

```json
{ "action": "adminImport", "key": "<ADMIN_KEY>",
  "items": [ { "date": "2026-10-10", "id": "<ID học viên>" }, ... ] }
```

- Kiểm tra trước: nếu có ngày không thuộc đợt nào hoặc ID không có trong `DanhSach`, **cả lô bị từ chối và không ghi gì** (phản hồi `code: "invalid"` kèm danh sách dòng lỗi).
- Dùng `LockService`; bỏ qua lượt đã có (khóa *Ngày + ID*) nên chạy lại không bị trùng (`added` / `skipped` trong phản hồi).
- Mỗi lượt ghi vào `Log` với `Timestamp` để trống và `Nguon = Nhập bù`; các ngày đã qua có thêm dữ liệu được tổng hợp lại ngay.
- Dữ liệu nhập bù là dữ liệu cá nhân: **không** đưa file nguồn lên GitHub (`*.csv` đã nằm trong `.gitignore`).

## Hàm quản trị

Gọi qua web (GET hoặc POST JSON), đều cần `key=<ADMIN_KEY>` (lưu trong *Cài đặt dự án → Thuộc tính tập lệnh*). Cũng có thể chạy trực tiếp các hàm cùng tên trong trình soạn thảo (không cần khóa).

| Hành động | Tham số | Tác dụng |
|---|---|---|
| `adminCheckin` | `date`, `id` | Điểm danh bù cho một người (`Nguon = Admin`); ngày đã qua thì tự tổng hợp lại |
| `adminDelete` | `date`, `id` | Xóa một lượt điểm danh khỏi `Log`; ngày đã qua thì tự tổng hợp lại |
| `adminSummary` | `date` | Chạy bù tổng hợp (`BC_` + `TongHop` + `ChuyenCan`) |
| `adminImport` | `items` = `[{date, id}]` | Nhập bù lượt điểm danh (xem *Nhập bù điểm danh*) |
| `adminExport` | `sheet` (mặc định `DanhSach`) | Xuất một tab dạng JSON (`DanhSach`, `Log`, `TongHop`, `ChuyenCan`, `BC_…`) |
| `adminDeleteDay` | `date`, `confirm=yes` | Xóa toàn bộ điểm danh của một ngày: các dòng trong `Log`, `BC_` và các dòng `TongHop` của ngày đó; tính lại `ChuyenCan` (dọn dữ liệu thử) |
| `adminDeleteTab` | `name` | Xóa tab `BC_…` |
| `adminRemovePerson` | `id` (dạng `TUAF-N001`) | Xóa hẳn một người tự đăng ký khỏi `DanhSach` và `Log`, đặt lại bộ đếm, tổng hợp lại các ngày bị ảnh hưởng |
| `adminRebuild` | – | Tính lại `ChuyenCan` |
| `adminClearCache` | – | Xóa bộ nhớ đệm (sau khi sửa tay `DanhSach`/`Log`) |
| `adminSetup` | – | Chạy lại `setup()` (an toàn, không ghi đè dữ liệu) |
| `adminDebug` | – | Danh sách tab (kể cả tab ẩn), múi giờ, trigger, bộ đếm, định dạng ô `Log` |
| `adminMigrate`, `adminMigrateCleanup` | `confirm=yes` | Chỉ dùng một lần để chuyển từ cấu trúc cũ (xem `apps-script/MigrateV3.gs`) |

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

Với `Log`, `TongHop`, `ChuyenCan` (để phân tích): mở Google Sheet → tab đó → *Tệp → Tải xuống → CSV*, hoặc `adminExport&sheet=Log`.

## Hạn chế cần biết

- **Danh sách học viên được phát công khai trong giờ mở** (cần để tìm kiếm trên điện thoại), gồm cả năm sinh và ghi chú (không gồm số điện thoại, `study_arm`, ngày đăng ký). Ngoài giờ, server từ chối. Ai biết URL đều có thể điểm danh hộ người khác (thiết kế không có mã buổi học).
- Khi hàng trăm người bấm cùng lúc, hệ thống xếp hàng và giao diện tự thử lại (tối đa 5 lần khi server báo bận). `Log` là nguồn dữ liệu duy nhất và được ghi trong khóa nên không còn tình trạng thiếu dòng.
- Form tự đăng ký giới hạn 60 lượt/ngày (chống spam, đếm theo `Ngay_dang_ky` trong `DanhSach`).
- Ghi vào `Log` dùng `setValues` (không dùng `appendRow`): `appendRow` bỏ qua định dạng ô và tự đổi `2026-10-17` thành kiểu ngày. Các cột ngày/giờ của `Log` luôn là chữ.
- **Chia sẻ Google Sheet:** nên đặt *Hạn chế* (chỉ người được mời). Ai sửa được Sheet đều mở được Apps Script gắn kèm và đọc `ADMIN_KEY`. Nếu nghi ngờ lộ khóa, đổi giá trị `ADMIN_KEY` trong *Thuộc tính tập lệnh*.

## Cấu trúc thư mục

```
index.html, style.css, app.js, search.js, config.js   giao diện (GitHub Pages)
apps-script/Code.gs, appsscript.json                  backend
apps-script/MigrateV3.gs                              chuyển một lần từ cấu trúc cũ (có thể xóa sau khi xong)
apps-script/RosterData.gs                              (không có trên GitHub) dữ liệu + khóa
prepare_roster.py                                      gộp 2 file Excel -> RosterData.gs
export_danhsach.py                                     xuất DanhSach ra Excel
```


## Giới hạn thiết bị và quản trị giờ (bản cập nhật)

- Mỗi thiết bị/trình duyệt được ghi nhận **một người mỗi ngày** theo ngày máy chủ (giờ Việt Nam). Hôm sau được điểm danh tiếp. Chọn người khác hoặc tự đăng ký sau lượt đầu đều bị chặn ở server, trong cùng khóa `LockService`. Gửi lại cùng người trả về kết quả đã ghi, không ghi thêm dòng.
- Trình duyệt lưu mã ngẫu nhiên trong `localStorage`; server lưu SHA-256 ở cột M (`Device_hash`) của `Log`. Không dùng địa chỉ IP để tránh chặn nhầm nhiều người chung Wi-Fi. Đổi trình duyệt, chế độ riêng tư hoặc xóa dữ liệu có thể tạo mã mới: đây là biện pháp hạn chế điểm danh hộ, không phải xác thực phần cứng tuyệt đối. Lượt cũ trước khi triển khai không có mã thiết bị và không thể truy ngược thiết bị.
- Admin điểm danh bù không chịu giới hạn thiết bị. Xóa một lượt trong `Log` qua `adminDelete` giải phóng thiết bị của lượt đó; không có bảng khóa thiết bị tách rời.
- Mở `admin.html`, đăng nhập bằng tên người dùng và mật khẩu được cấu hình riêng trong Apps Script → Project Settings → Script Properties (`ADMIN_USERNAME`, `ADMIN_PASSWORD`). Trang chỉ giữ thông tin đăng nhập trong bộ nhớ, không ghi localStorage/sessionStorage; tải lại/đăng xuất sẽ bỏ thông tin này. Không đưa mật khẩu vào code, URL, GitHub hoặc PR.
- Chọn giờ mặc định hoặc một ngày học cụ thể, đặt giờ mở/đóng rồi lưu; có thể đóng cả ngày và xóa lịch riêng để trở về mặc định. Khung giờ nằm trong cùng ngày và trong hai đợt học đã cấu hình. Việc lưu giờ không tự mở rộng đợt học hay tạo buổi học mới. Website lấy lại trạng thái tối đa mỗi 60 giây; máy chủ kiểm tra lại khi ghi nhận.
- API mới dùng **POST JSON**: `adminGetSchedule` (`key`), `adminSetSchedule` (`key`, `date` hoặc chuỗi rỗng cho mặc định, `openAt`, `closeAt`, `closed` dạng boolean). Xóa lịch riêng: `adminSetSchedule` với `date` và `reset: true`.
- API `checkin` và `register` nay yêu cầu `deviceId` (mã ngẫu nhiên 20–80 ký tự chữ/số/gạch dưới/gạch ngang). Không dùng lại bộ nhớ đệm `reqId` cũ; tính lặp an toàn dựa trên `Log` và danh sách tự đăng ký.

### Triển khai theo thứ tự

1. Trong **dự án Apps Script hiện đang phục vụ URL ở config.js**, thay `Code.gs` bằng bản mới trong `apps-script/Code.gs`. Giữ nguyên `RosterData.gs`, `SHEET_ID`, `ADMIN_KEY`, dữ liệu Sheets và các file nội bộ. Không chạy `setup()` nếu không có `RosterData.gs`; cột `Device_hash` được thêm tự động khi ghi nhận lượt mới. Không ghi đè cột M nếu đang chứa dữ liệu khác.
2. Apps Script → **Deploy → Manage deployments → Edit → Version: New version → Deploy**. Sửa deployment đang dùng để giữ nguyên URL `/exec`; không tạo Web App khác. Link `/exec` chỉ chạy API, không phải trang chỉnh sửa mã nguồn. Người triển khai cần quyền chỉnh sửa dự án Apps Script, tách biệt quyền GitHub.
3. Kiểm tra `?action=status` trả về `openAt`/`closeAt` và thử API quản trị trên dữ liệu thử trước. Sau đó hợp nhất PR để GitHub Pages xuất bản `app.js`, `admin.html`, `admin.js`, `index.html`, `style.css`. Trong lúc cập nhật Apps Script trước giao diện, bản giao diện cũ sẽ được yêu cầu tải lại vì chưa gửi `deviceId`; nên triển khai trong thời gian nghỉ điểm danh.
4. Mở trang quản trị, đặt giờ thử và kiểm tra trên hai thiết bị: thiết bị thứ nhất điểm danh một người, đổi tên/tải lại/tự đăng ký phải bị chặn; thiết bị thứ hai vẫn điểm danh được. Không tạo dữ liệu thử trong ngày học thật; dùng môi trường thử hoặc dọn dữ liệu thử qua API admin đã có.
5. Trigger tổng hợp hiện có vẫn chạy 17:00–18:00. Nếu mở điểm danh sau giờ này, chạy `adminSummary` cho ngày đó sau khi kết thúc để báo cáo lấy đủ lượt muộn. Bản cập nhật này giữ lịch trigger hiện có.

Kiểm tra tự động: `node --test tests/attendance.test.cjs` (Node.js 18+). Các kiểm thử dùng dịch vụ giả lập trong bộ nhớ, không gọi API sản xuất hay sửa Sheets thật.


### Kiểm tra và triển khai bản sửa này

- Chưa triển khai giới hạn thiết bị hoặc trang admin lên hệ thống thật. Cần phối hợp Apps Script và GitHub Pages trong giờ nghỉ điểm danh, giữ nguyên deployment và URL `/exec`.
- Trong dự án Apps Script đã cập nhật riêng quy tắc Đợt 0 và `SUMMARY_HOUR = 17`; báo cáo ngày 24/10 đã chạy lại thành công. Đây chưa phải triển khai bản giới hạn thiết bị.
- Đợt 0 trong DanhSach là quy ước loại khỏi BC_, TongHop và ChuyenCan. Log gốc vẫn giữ nguyên. Quy tắc áp dụng khi chạy tổng hợp lại, không tự thay đổi các tab BC_ lịch sử chưa được chạy lại.
- Hiện đã có trigger mới dưới tài khoản hiện tại, chạy dailySummaryTrigger trên HEAD trong khung 17:00–18:00 GMT+7. Trigger cũ thuộc tài khoản khác, hiển thị deployment “Phiên bản 14”, vẫn còn. Chủ trigger cũ cần xóa trigger đó (hoặc cập nhật đúng bản triển khai) để chỉ còn một lịch; bản cũ có thể ghi đè báo cáo bằng quy tắc cũ. Không chạy setup() để cài thêm trigger. Chỉ cập nhật mã không tự dời các trigger đã cài.
- Kiểm thử giờ giả lập theo từng yêu cầu bằng fake và key trên môi trường thử; không dùng adminFake/testMode toàn hệ thống khi đang phục vụ học viên thật. Không đưa ADMIN_KEY vào repo, PR, log hoặc ảnh chụp.
- Dùng chung điện thoại: người thứ hai sẽ bị chặn sau khi người thứ nhất điểm danh trong ngày, kể cả hai người đều là học viên thật. Họ cần thiết bị khác hoặc admin ghi nhận bù; đây là giới hạn có chủ đích của yêu cầu mỗi thiết bị một lần/ngày. Đổi trình duyệt/xóa localStorage/chế độ riêng tư có thể vượt giới hạn. Người dùng chặn localStorage sẽ không điểm danh được qua web, cần admin hỗ trợ. Bản ghi cũ không có Device_hash thì không thể áp dụng hồi tố giới hạn thiết bị.


### Đăng nhập trang quản trị bằng username/password

Khi triển khai, người quản trị tự cấu hình hai Script Properties trong dự án Apps Script:

| Thuộc tính | Giá trị |
|---|---|
| ADMIN_USERNAME | Tên đăng nhập đã thống nhất (admin) |
| ADMIN_PASSWORD | Mật khẩu được cung cấp riêng, không đưa vào GitHub |

Không cần và không được đặt mật khẩu trong config.js/admin.js/admin.html hoặc trong mô tả PR. Script Properties là cấu hình phía máy chủ; chỉ chia sẻ quyền sửa dự án với người được phép đọc cấu hình này. Mật khẩu được lưu trong Script Properties riêng tư và được so sánh bằng SHA-256 tại máy chủ; đây không phải cơ chế băm mật khẩu lưu trữ. Tài khoản username/password chỉ được gọi adminGetSchedule và adminSetSchedule qua POST. Các API quản trị dữ liệu điểm danh hiện có vẫn dùng ADMIN_KEY, không thay đổi khóa cũ. Chưa cấu hình đủ hai thuộc tính, sai tên hoặc sai mật khẩu đều bị từ chối. Không có mật khẩu mặc định trong repo.
