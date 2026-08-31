# TDMS1VN — Full-stack

Đây là bản hợp nhất **một repository / một project**: Express vừa chạy API vừa phục vụ toàn bộ frontend tĩnh từ `public/`.

## Cấu trúc

- `server.js` — Express master app, Firebase Admin, auth, API và static frontend
- `services.js` — Provider services
- `order.js` — đặt đơn, trừ số dư, provider order, refund
- `deposit.js` — nạp tiền, gateway callback, Telegram webhook
- `cron.js` — đồng bộ trạng thái đơn
- `public/index.html` — frontend SPA
- `public/logo.png`
- `public/favicon.ico`
- `firestore.rules`
- `.env.example`
- `package.json`

## Chạy local

```bash
npm install
npm start
```

Mở `http://localhost:8080`.

## Railway

Import **repository này** vào Railway. Root Directory để `/` và Start Command là `npm start`.
Railway sẽ phục vụ frontend và API cùng một domain:

- Website: `/`
- Health: `/health`
- API: `/api/...`

Frontend dùng `const API_BASE = '/api'`, vì vậy không còn gọi trực tiếp sang domain Railway khác và không cần CORS cho hoạt động bình thường.

## Biến môi trường

Copy `.env.example` thành cấu hình Environment Variables trên Railway và điền giá trị thật. Không commit credential Firebase, Provider hoặc Telegram.

`FIREBASE_SERVICE_ACCOUNT_JSON` phải là JSON service-account hợp lệ trên một dòng (Railway có thể lưu nguyên JSON).

`TELEGRAM_WEBHOOK_SECRET` là secret tùy chọn để bảo vệ endpoint Telegram webhook. URL webhook khi dùng domain Railway này là:

`https://<RAILWAY-DOMAIN>/api/deposits/telegram/webhook`

`DEPOSIT_CALLBACK_URL` nếu dùng cổng nạp thẻ là:

`https://<RAILWAY-DOMAIN>/api/deposits/gateway/callback`

## Quan trọng

Các endpoint người dùng `/api/orders` và `/api/deposits` yêu cầu Firebase ID token. Frontend tự lấy token từ Firebase Auth và gửi `Authorization: Bearer <token>`.
