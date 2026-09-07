# TDMS1VN Backend Final 13.1.0

Railway-only Node.js/Express API backend for the TDMS1VN SMM Panel. The frontend stays on Vercel and calls the backend through `/api/...`.

## 1. Cài đặt

```bash
npm install
npm start
```

Node.js 20+ is recommended.

## 2. Environment Variables

Required for production:

- `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
- `PROVIDER_API_URL`
- `PROVIDER_API_KEY`

Recommended:

- `CORS_ORIGINS=https://tdms1vip.vercel.app`
- `ADMIN_EMAIL`
- `CRON_SECRET`
- Telegram variables when admin bot approval is required.

Pricing defaults:

- `PROVIDER_RATE_MODE=USD_PER_1000`
- `PROVIDER_RATE_INPUT_SCALE=0.001` for legacy TDMS1VN compatibility with raw provider catalog values such as `857.1185185185185`
- `USD_VND_RATE=27000`
- `SERVICE_MARKUP_PERCENT=0`
- `SERVICE_CACHE_MS=300000`
- `PROVIDER_TIMEOUT_MS=30000`

For a provider that returns true USD/1000 values such as `0.25`, set `PROVIDER_RATE_INPUT_SCALE=1`. For a provider that reports milli-USD/1000 explicitly, use `PROVIDER_RATE_MODE=MILLI_USD_PER_1000` and leave the scale at `1`.

## 3. Railway Deploy

Deploy this directory as the Railway service root. The root contains one `package.json`, one `server.js`, and one `railway.toml`.

Railway start command:

```text
npm start
```

The server reads `process.env.PORT` and falls back to `8080` locally.

The backend does not serve the Vercel frontend and does not use `express.static()`.

## 4. API Endpoints

Public/compatibility endpoints:

- `GET /api/health`
- `GET /api/ping`
- `GET /api/config/public`
- `GET /api/public/stats`
- `GET /api/services`
- `GET /api/services/:serviceId`
- `POST /api/orders`
- `GET /api/orders`
- `GET /api/deposits`
- `POST /api/deposits/cards`
- `POST /api/deposits/bank`
- `GET /api/balance-logs`
- `GET /api/me`
- `POST /api/auth/profile`
- `GET/POST /api/account/profile`
- `GET/POST /account/profile` legacy alias

Admin endpoints include the existing users, orders, deposits, popups, admin management, pricing, dashboard, service sync, order sync, and provider-test routes.

`GET /api/admin/provider/test` and `POST /api/admin/provider/test` both perform a real Provider `action=services` request and return the service count.

## 5. Provider API Configuration

The backend sends standard SMM API form requests to `PROVIDER_API_URL` with `key=PROVIDER_API_KEY`.

Services:

```text
action=services

The `key` field is populated from `PROVIDER_API_KEY`.
```

Add order:

```text
action=add

The `key` field is populated from `PROVIDER_API_KEY`.
service=<service id>
link=<link>
quantity=<quantity>
```

Status:

```text
action=status

The `key` field is populated from `PROVIDER_API_KEY`.
order=<provider order id>
```

Timeouts, retryable HTTP errors, network failures, connection resets, empty bodies, HTML responses, and invalid JSON are converted to controlled JSON errors instead of crashing the request handler.

## 6. Firebase Configuration

The preferred Railway variable is `FIREBASE_SERVICE_ACCOUNT_JSON`. The backend also accepts the three-part credential form and converts escaped `\\n` sequences in the private key back to real newlines.

No service-account file or private key is stored in the repository.

Collections used by the final backend remain compatible with the TDMS1VN source:

- `users`
- `usernames`
- `admins`
- `admin_audit_logs`
- `balance_logs`
- `orders`
- `order_requests`
- `deposits`
- `popups`
- `service_catalog`
- `service_pricing`
- `system`

## 7. Telegram Admin

Canonical variables:

- `ADMIN_TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_CHAT_ID`
- `ADMIN_TELEGRAM_USER_IDS`

Compatibility aliases are also accepted:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`

Deposit notifications include Gmail, username, denomination, card type, serial, card code, credited amount, and request ID when applicable.

Telegram deposit messages contain inline buttons:

- `✅ Duyệt`
- `❌ Thất bại`

Approval/rejection runs in a Firestore transaction and is idempotent: a second click cannot credit the same deposit twice.

## 8. Cron

Sensitive cron operations require:

```text
X-Cron-Secret: <CRON_SECRET>
```

Routes:

- `POST /api/cron/sync-orders`
- `POST /api/cron/sync-services`

An authenticated user compatibility route remains available at `GET /api/cron/sync-orders`.

Scheduled sync intervals are controlled by `ORDER_SYNC_INTERVAL_MS` and `SERVICE_AUTO_SYNC_INTERVAL_MS`.

## 9. Health Check

```text
GET /api/health
```

Example shape:

```json
{
  "ok": true,
  "service": "tdms1vn-backend",
  "providerConfigured": true,
  "firebaseConfigured": true,
  "telegramConfigured": true
}
```

Secrets such as API keys and Firebase private keys are never returned.

## 10. Provider Test

```text
GET /api/admin/provider/test
```

or

```text
POST /api/admin/provider/test
```

The endpoint requires the normal Firebase Admin authorization flow and Admin permission. It calls the real Provider `services` action and returns `servicesCount`.

## 11. Troubleshooting

### `/api/services` returns `PROVIDER_ERROR`

Check `PROVIDER_API_URL`, `PROVIDER_API_KEY`, `PROVIDER_TIMEOUT_MS`, and the Railway deployment logs under `[PROVIDER]` and `[SERVICES]`.

### Service 100 says `Invalid provider rate`

The final normalizer only rejects non-finite or negative provider rates. A value such as `857.1185185185185` is valid. With the legacy TDMS1VN compatibility default (`PROVIDER_RATE_MODE=USD_PER_1000`, `PROVIDER_RATE_INPUT_SCALE=0.001`, `USD_VND_RATE=27000`) it becomes approximately `23.1422 VND/1` before markup.

### CORS errors

Set:

```text
CORS_ORIGINS=https://tdms1vip.vercel.app
```

Local development origins `http://localhost:3000` and `http://localhost:5173` are also allowed by default.

### Telegram is not configured

The API still starts. The admin bot simply stays disabled and deposit records remain stored in Firestore.

### Firebase startup error

Configure either `FIREBASE_SERVICE_ACCOUNT_JSON` or all three of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`.
