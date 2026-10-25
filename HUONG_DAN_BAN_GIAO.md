# Bàn giao website điểm danh Futurework

## Backend đang sử dụng

- Tài khoản triển khai: thuthuy.dang@depocen.org.
- Apps Script project: 1uP_e15ozJRD3Gr-FdWr0ftpNs3TwBKCAeyEjoWSrgknLwCG-j5MMf8jN.
- Deployment ID: AKfycby1h8nNu1_h5hGtOqCEfxRAl5pvbqCrVD3jgRsYC4dC2REdwlaEgxELjtfxFfHjJs3grQ.
- Web App: https://script.google.com/macros/s/AKfycby1h8nNu1_h5hGtOqCEfxRAl5pvbqCrVD3jgRsYC4dC2REdwlaEgxELjtfxFfHjJs3grQ/exec
- Execute as: Me; Who has access: Anyone.
- Code.gs là backend trong apps-script/Code.gs của repo. RuntimeConfig.gs của dự án mới khai báo SHEET_ID trỏ Sheet gốc 129QOMvS1lM0tLewS-F_YFqIKUhOIPSZc-czpxKlqXLc. Không cần sao chép danh sách học viên vào mã; đọc trực tiếp DanhSach.

## Cập nhật cùng URL

Dùng clasp đăng nhập bằng tài khoản triển khai. Kiểm tra .clasp.json trỏ đúng project mới, đồng bộ và bảo toàn RuntimeConfig.gs trước khi push. Không push nhầm thư mục thiếu cấu hình hoặc chứa dữ liệu/khóa riêng lên GitHub.

```sh
clasp push && clasp deploy -i AKfycby1h8nNu1_h5hGtOqCEfxRAl5pvbqCrVD3jgRsYC4dC2REdwlaEgxELjtfxFfHjJs3grQ
```

Trong editor có thể dùng Deploy → Manage deployments → Edit → New version → Deploy. Cập nhật deployment này để giữ URL; không tạo deployment mới cho mỗi lần sửa. Kiểm tra action=status sau cập nhật và phối hợp frontend/backend ngoài giờ lớp khi có thay đổi không tương thích.

## Cấu hình riêng

ADMIN_USERNAME và ADMIN_PASSWORD nằm trong Script Properties của project mới, không ghi mật khẩu vào repo. Username/password chỉ quản trị giờ; các API admin khác dùng ADMIN_KEY riêng. ADMIN_KEY không tự chuyển từ project cũ. Không chạy setup() để tạo khóa vì setup còn sửa dữ liệu và tạo trigger.

## Dữ liệu và lịch tổng hợp

Giữ nguyên Sheet gốc và deployment cũ. Project Web App mới không cài thêm trigger. Trigger tổng hợp vẫn thuộc project cũ; việc đổi API_URL không chuyển trigger sang project mới. Đã từng có cả lịch HEAD 17–18h và lịch Version 14 khoảng 19h thuộc tài khoản khác; cần chủ trigger kiểm tra và chỉ giữ lịch mong muốn. Không khẳng định trigger ghim version cũ tự chạy mã HEAD mới. Bản cũ có thể ghi đè báo cáo chưa loại Đợt 0.

Đợt 0 không tính báo cáo, Log gốc giữ nguyên. Giới hạn thiết bị là một mã trình duyệt/ngày VN; dùng chung trình duyệt chặn người thứ hai, xóa dữ liệu hoặc đổi trình duyệt có thể vượt giới hạn. Nếu mở điểm danh qua giờ tổng hợp, cần tổng hợp lại sau giờ đóng.

## Kiểm tra

Ngày 25/10/2026: action=status trả fake=false, giờ VN, lịch 08:00–17:00; action=roster đọc 335 học viên từ Sheet gốc. Kiểm tra website thật sau GitHub Pages cập nhật. Lượt thử phải dùng dữ liệu thử riêng và xóa chính xác theo ngày + ID, không xóa điểm danh học viên thật.
