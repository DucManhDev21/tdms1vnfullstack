# TDMS1VN Fixed

## Kiến trúc
- Frontend: Vercel (`frontend/`)
- Backend API: Railway (`backend/`)
- Firebase Auth + Firestore: dùng chung cho frontend/backend
- Telegram Bot: chạy trong backend

## API_BASE_URL
Frontend phải gọi:
`https://tdms1vnfullstack-production.railway.app/api`

## Railway
Deploy thư mục `backend/` với Start Command:
`npm start`

Bắt buộc có biến môi trường `FIREBASE_SERVICE_ACCOUNT_JSON`, `CORS_ORIGINS` và các biến Provider/Telegram hiện tại của bạn.

Khuyến nghị `CORS_ORIGINS`:
`https://tdms1vip.vercel.app`

Kiểm tra:
- `GET /health`
- `GET /api`
- `GET /api/config/public`

## Vercel
Deploy thư mục `frontend/`. `vercel.json` đã bỏ rewrite `/api/*` vì backend API nằm trên Railway, đồng thời bỏ Vercel Cron gọi nhầm về Vercel.

Các route SPA như `/dat-hang` được rewrite về `/index.html`, nên F5 không còn 404.
