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

Frontend Vercel gọi API Railway qua `API_BASE`. Hãy đặt `CORS_ORIGINS=https://tdms1vip.vercel.app` (có thể thêm nhiều origin, ngăn cách bằng dấu phẩy) trên Railway.

## Biến môi trường

Copy `.env.example` thành cấu hình Environment Variables trên Railway và điền giá trị thật. Không commit credential Firebase, Provider hoặc Telegram.

`FIREBASE_SERVICE_ACCOUNT_JSON` phải là JSON service-account hợp lệ trên một dòng (Railway có thể lưu nguyên JSON).

`TELEGRAM_WEBHOOK_SECRET` là secret tùy chọn để bảo vệ endpoint Telegram webhook. URL webhook khi dùng domain Railway này là:

`https://<RAILWAY-DOMAIN>/api/deposits/telegram/webhook`

`DEPOSIT_CALLBACK_URL` nếu dùng cổng nạp thẻ là:

`https://<RAILWAY-DOMAIN>/api/deposits/gateway/callback`

## Quan trọng

Các endpoint người dùng `/api/orders` và `/api/deposits` yêu cầu Firebase ID token. Frontend tự lấy token từ Firebase Auth và gửi `Authorization: Bearer <token>`.

## Deploy tách Frontend Vercel + Backend Railway

Frontend chỉ chứa `public/index.html`, `public/logo.png`, `public/favicon.ico` và `vercel.json`.
Backend chứa `server.js`, `order.js`, `deposit.js`, `services.js`, `cron.js`, `package.json` và biến môi trường.

### Vercel

Deploy thư mục frontend. `vercel.json` rewrites mọi route SPA về `/index.html`, nên F5 `/dat-hang`, `/don-hang-da-tat`, `/bien-dong-so-du`... không còn 404.

### Railway

Deploy thư mục backend. Start command: `npm start`.
Bắt buộc đặt `CORS_ORIGINS=https://tdms1vip.vercel.app` (thay bằng domain Vercel thật).

### Firebase Admin custom claim

Nếu muốn dùng Firestore Rules với tài khoản admin ở client, tài khoản đó phải có custom claim `{ admin: true }`. Backend Telegram vẫn dùng Firebase Admin SDK nên không bị Firestore Rules chặn.
