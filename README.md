# TDMS1VN Backend FINAL 13.0.1

## Railway
- Root Directory: `/`
- Start Command: `node server.js`
- Node.js: >=20

## Required environment variables
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PROVIDER_API_URL=https://theodoigiatot.com/api/v2`
- `PROVIDER_API_KEY`

Optional provider settings have safe defaults.

## Health checks
- `/api/health`
- `/api/version`
- Admin-only provider test: `/api/admin/provider/test`

Do not expose or commit `.env` or API keys.
