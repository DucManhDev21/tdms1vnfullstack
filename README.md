# TDMS1VN Backend 13.1.0

Backend Node.js/Express for Railway.

## Required Railway variables

- `PORT` (Railway can provide this automatically)
- `CORS_ORIGINS=https://tdms1vip.vercel.app`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PROVIDER_API_URL`
- `PROVIDER_API_KEY`
- `USD_VND_RATE=27000`
- `PROVIDER_RATE_MODE=USD_PER_1000`
- `SERVICE_MARKUP_PERCENT=30`

Keep the Provider API key only on Railway.

## Provider pricing compatibility

Version 13.1.0 fixes the pricing pipeline. The normalized provider unit price is now passed explicitly to the pricing layer instead of re-reading the raw provider `rate`.

For `USD_PER_1000`, both common provider formats are accepted:
- `0.857...` USD/1000
- `857.118...` milli-USD/1000

A malformed individual provider service is skipped instead of causing the entire `/api/services` endpoint to return 502.

## Deploy

Deploy this directory as the Railway service root. Railway will run:

`npm start`

After deployment test:

`GET /api/health`

Then:

`GET /api/services`

Expected `/api/services` response contains `services`, `count`, and pricing fields.
