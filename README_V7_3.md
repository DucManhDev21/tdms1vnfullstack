# TDMS1VN V7.3

## Điểm mới
- Giao diện toàn hệ thống bắt buộc monochrome: chỉ đen, trắng và xám trung tính. Không dùng xanh lá, xanh dương, tím, đỏ, cam hoặc màu accent.
- Popup Thông Báo Chung đã loại bỏ màu xanh lá; nút và trạng thái đều trung tính.
- Thêm `/admin-setup` để tạo quyền Admin lần đầu ngay trên điện thoại.
- Setup được khóa bằng Firestore transaction sau lần thành công đầu tiên.
- Backend `/api/admin/setup` yêu cầu Firebase Bearer token, Gmail đã xác minh và `ADMIN_SETUP_SECRET`.
- Sau khi cấp custom claims `admin=true, role=admin`, refresh token bị thu hồi để buộc đăng nhập lại.
- Giữ nguyên frontend Vercel `https://tdms1vip.vercel.app` và backend Railway.

## Railway Variables mới
`ADMIN_SETUP_SECRET` — chuỗi ngẫu nhiên ít nhất 16 ký tự.

## Quy trình
1. Tạo/điền `ADMIN_SETUP_SECRET` trên Railway.
2. Deploy backend.
3. Mở `https://tdms1vip.vercel.app/admin-setup`.
4. Đăng ký hoặc đăng nhập Gmail Admin.
5. Xác minh Gmail.
6. Gửi lại form với secret để cấp quyền.
7. Đăng nhập tại `https://tdms1vip.vercel.app/admin-login`.
8. Sau khi hoàn tất, có thể xóa/rotate `ADMIN_SETUP_SECRET` trên Railway.
