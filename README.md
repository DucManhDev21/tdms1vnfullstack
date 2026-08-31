# TDMS1VN — Full-stack Vercel

## Cấu trúc

- `index.html` — bản SPA dùng khi deploy Vercel
- `server.js` — Express API + local server
- `api/index.js` — Vercel Function adapter
- `services.js` — Provider services
- `order.js` — đặt đơn + Firestore Transaction + refund
- `deposit.js` — nạp thẻ + Telegram Bot + callback
- `cron.js` — đồng bộ trạng thái đơn
- `firestore.rules` — Firestore security rules
- `vercel.json` — SPA rewrite + API rewrite

## Deploy Vercel

Repository phải có `package.json` và `server.js` ở root. Vercel dùng `api/index.js` làm serverless function, còn SPA được rewrite về `/index.html`.

Environment Variables bắt buộc cho API:

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PROVIDER_API_URL`
- `PROVIDER_API_KEY`
- `CRON_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`

Các biến nạp thẻ là bắt buộc khi sử dụng gateway thật.

## Telegram webhook

URL:

`https://YOUR-VERCEL-DOMAIN.vercel.app/api/deposits/telegram/webhook`

`TELEGRAM_WEBHOOK_SECRET` phải được gửi bởi Telegram trong header `X-Telegram-Bot-Api-Secret-Token`.

## Cron

`cron.js` hỗ trợ request có `Authorization: Bearer <CRON_SECRET>` hoặc `X-Cron-Secret`.

Vercel có thể gọi endpoint theo lịch khi project/plan của bạn hỗ trợ Cron Jobs. Vercel cung cấp Cron Jobs và cấu hình schedule trong `vercel.json`. 

## Vercel

Vercel serves the static SPA from the repository root and routes `/api/*` to `api/index.js`.
Do not put Firebase service-account JSON, Provider API keys, Telegram tokens, or webhook secrets in the repository.

## Firebase Admin claim for admin

Set a Firebase Auth custom claim `admin: true` or `role: "admin"` for the Telegram/admin operator account if you also need browser-side admin access. Server-side Admin SDK operations bypass Firestore client rules.

## Firestore index

For the `orders`, `deposits`, and `balance_logs` queries using `where(uid == ...) + orderBy(createdAt desc)`, create the corresponding composite indexes in Firestore if Firebase reports `FAILED_PRECONDITION`.
