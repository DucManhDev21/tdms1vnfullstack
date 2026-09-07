# TDMS1VN Backend FINAL 13.1.0

Đây là TOÀN BỘ BACKEND dành cho Railway. Không chứa index.html.

## Cấu trúc
- server.js — Express API chính
- provider.js — Provider API client, POST /api/v2
- services.js — lấy/chuẩn hóa/cache dịch vụ
- pricing.js — giá bán và tính tổng tiền
- order.js — tạo đơn + trừ tiền bằng Firestore Transaction
- order-sync.js — đồng bộ trạng thái + hoàn tiền
- deposit.js — nạp tiền
- admin-bot.js — Telegram Admin Bot
- admins.js — quản lý Admin
- cron.js — cron/sync
- firebase.json
- firestore.rules
- .env.example
- package.json
- railway.toml

## Railway
Upload các file trong ZIP này ở ROOT repository.

Biến bắt buộc:
- FIREBASE_SERVICE_ACCOUNT_JSON
- PROVIDER_API_URL
- PROVIDER_API_KEY

Provider:
PROVIDER_API_URL=https://theodoigiatot.com/api/v2

Rate mặc định:
PROVIDER_RATE_MODE=USD_PER_1000
USD_VND_RATE=27000

Với rate Provider 857.1185185185185, backend quy đổi khoảng 23.1422 VND/1.

## Kiểm tra sau deploy
1. /health
2. /api/health
3. /api/services

/api/services là PUBLIC; frontend không cần Firebase Bearer Token để lấy danh sách dịch vụ.

## Frontend
Frontend Vercel gọi /api/services. Không gọi trực tiếp Provider từ browser và không đưa PROVIDER_API_KEY vào index.html.
