const express = require('express');
const axios = require('axios');
const router = express.Router();
const {
  applyPricing,
  defaultMarkupPercent,
  getPricingOverrides,
  roundMoney
} = require('./pricing');

const CACHE_MS = Number(process.env.SERVICE_CACHE_MS || 5 * 60 * 1000);
let cachedServices = null;
let cachedAt = 0;
let refreshPromise = null;

function providerClient() {
  const baseURL = String(process.env.PROVIDER_API_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.PROVIDER_API_KEY || '').trim();

  if (!baseURL || !key) {
    throw new Error('Provider API is not configured');
  }

  return axios.create({
    baseURL,
    timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000),
    validateStatus: () => true
  });
}

function detectPlatform(name, category, raw) {
  const text = `${name || ''} ${category || ''} ${raw?.platform || ''}`.toLowerCase();

  if (text.includes('tiktok') || text.includes('tik tok')) return 'TikTok';
  if (text.includes('facebook') || text.includes('fb')) return 'Facebook';
  if (text.includes('instagram') || text.includes('ig')) return 'Instagram';
  if (text.includes('youtube') || text.includes('yt')) return 'Youtube';
  if (text.includes('telegram') || text.includes('tele')) return 'Telegram';
  if (text.includes('shopee')) return 'Shopee';

  return 'Khác';
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(value).toLowerCase()
  );
}

function parseNumber(value, fallback = NaN) {
  if (value == null || value === '') return fallback;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const normalized = String(value)
    .trim()
    .replace(/,/g, '');

  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function extractProviderRate(row) {
  // Different SMM providers/accounts may expose the same price under
  // different property names. Prefer the standard `rate`.
  const candidates = [
    row?.rate,
    row?.price,
    row?.providerRate,
    row?.provider_rate,
    row?.cost,
    row?.unitRate,
    row?.unitRateVnd
  ];

  for (const candidate of candidates) {
    const number = parseNumber(candidate);
    if (Number.isFinite(number) && number >= 0) return number;
  }

  return NaN;
}

function convertProviderRateToVndPerUnit(rateNumber, mode) {
  if (!Number.isFinite(rateNumber) || rateNumber < 0) return NaN;

  if (mode === 'VND_PER_1') {
    return rateNumber;
  }

  if (mode === 'VND_PER_1000') {
    return rateNumber / 1000;
  }

  if (mode === 'USD_PER_1000') {
    const usdVnd = parseNumber(process.env.USD_VND_RATE || 27000);

    if (!Number.isFinite(usdVnd) || usdVnd <= 0) {
      throw new Error('USD_VND_RATE is invalid');
    }

    /*
     * Provider compatibility:
     * - values below 10 are treated as USD/1000 directly (e.g. 0.857...)
     * - values >= 10 are treated as milli-USD/1000 (e.g. 857.118...)
     *
     * This matches the catalog format previously known to work for TDMS1VN.
     */
    const usdPer1000 = rateNumber >= 10
      ? rateNumber / 1000
      : rateNumber;

    return usdPer1000 * usdVnd / 1000;
  }

  throw new Error(`Unsupported PROVIDER_RATE_MODE: ${mode}`);
}

function normalizeService(row) {
  const service = parseNumber(row?.service ?? row?.id);
  const name = String(row?.name ?? '').trim();
  const category = String(
    row?.category ?? row?.type ?? 'Khác'
  ).trim() || 'Khác';
  const platform = detectPlatform(name, category, row);
  const type = String(row?.type ?? 'Default').trim() || 'Default';

  const rateNumber = extractProviderRate(row);
  const minNumber = Number.parseInt(row?.min ?? 0, 10);
  const maxNumber = Number.parseInt(row?.max ?? 0, 10);
  const mode = String(
    process.env.PROVIDER_RATE_MODE || 'USD_PER_1000'
  ).trim().toUpperCase();

  if (
    !Number.isFinite(service) ||
    !Number.isSafeInteger(service) ||
    !name ||
    !Number.isFinite(rateNumber) ||
    rateNumber < 0 ||
    !Number.isFinite(minNumber) ||
    !Number.isFinite(maxNumber) ||
    minNumber < 0 ||
    maxNumber < minNumber
  ) {
    return null;
  }

  const providerUnitVnd = convertProviderRateToVndPerUnit(
    rateNumber,
    mode
  );

  if (!Number.isFinite(providerUnitVnd) || providerUnitVnd < 0) {
    return null;
  }

  const base = {
    service,
    name,
    type,
    platform,
    category,
    providerRate: roundMoney(rateNumber),
    providerRateMode: mode,
    providerUnitRateVnd: roundMoney(providerUnitVnd),
    min: String(minNumber),
    max: String(maxNumber),
    refill: toBool(row?.refill),
    cancel: toBool(row?.cancel)
  };

  // applyPricing now explicitly prefers providerUnitRateVnd.
  return applyPricing(base);
}

async function fetchProviderServices() {
  const key = String(process.env.PROVIDER_API_KEY || '').trim();
  const client = providerClient();

  const response = await client.post(
    '',
    new URLSearchParams({
      key,
      action: 'services'
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const body =
      typeof response.data === 'string'
        ? response.data.slice(0, 500)
        : JSON.stringify(response.data).slice(0, 500);

    throw new Error(
      `Provider HTTP ${response.status}${body ? `: ${body}` : ''}`
    );
  }

  if (!Array.isArray(response.data)) {
    throw new Error('Provider services response is not an array');
  }

  const normalized = [];

  for (const row of response.data) {
    try {
      const service = normalizeService(row);
      if (service) normalized.push(service);
    } catch (error) {
      // A malformed provider row must not take down the whole catalog.
      console.warn(
        `Skipping invalid provider service ${row?.service ?? row?.id ?? 'unknown'}:`,
        error.message
      );
    }
  }

  if (!normalized.length) {
    throw new Error('Provider returned no usable services');
  }

  return normalized;
}

async function persistCatalog(db, services) {
  if (!db || !services.length) return;

  const chunkSize = 400;

  for (let index = 0; index < services.length; index += chunkSize) {
    const batch = db.batch();

    for (const service of services.slice(index, index + chunkSize)) {
      const ref = db.collection('service_catalog').doc(
        String(service.service)
      );

      batch.set(
        ref,
        {
          ...service,
          lastSyncedAt: new Date()
        },
        { merge: true }
      );
    }

    await batch.commit();
  }

  await db.collection('system').doc('serviceSync').set(
    {
      serviceCount: services.length,
      syncedAt: new Date(),
      providerRateMode:
        process.env.PROVIDER_RATE_MODE || 'USD_PER_1000',
      defaultMarkupPercent: defaultMarkupPercent()
    },
    { merge: true }
  );
}

async function getServices(forceRefresh = false, db = null) {
  const now = Date.now();

  if (
    !forceRefresh &&
    cachedServices &&
    now - cachedAt < CACHE_MS
  ) {
    return cachedServices;
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const freshBase = await fetchProviderServices();
      const overrides = await getPricingOverrides(db);

      const fresh = freshBase
        .map(service =>
          applyPricing(
            service,
            overrides.get(String(service.service))
          )
        )
        .filter(service => service.enabled);

      if (!fresh.length) {
        throw new Error('No enabled services after pricing');
      }

      cachedServices = fresh;
      cachedAt = Date.now();

      if (db) await persistCatalog(db, fresh);

      return fresh;
    } catch (error) {
      if (cachedServices?.length) {
        console.error(
          'Provider refresh failed; serving cached services:',
          error.message
        );
        return cachedServices;
      }

      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function syncServices(db, forceRefresh = true) {
  return getServices(forceRefresh, db);
}

router.get('/', async (req, res) => {
  try {
    const services = await getServices(
      req.query.refresh === '1',
      req.app.locals.db
    );

    res.set('Cache-Control', 'no-store');

    res.json({
      services,
      cachedAt,
      count: services.length,
      defaultMarkupPercent: defaultMarkupPercent()
    });
  } catch (error) {
    console.error('services:', error);

    res.status(502).json({
      error: 'Không lấy được danh sách dịch vụ từ Provider',
      code: 'PROVIDER_ERROR',
      httpStatus: error?.response?.status ?? null,
      message: error?.message || 'Provider request failed',
      providerConfigured: Boolean(
        process.env.PROVIDER_API_URL &&
        process.env.PROVIDER_API_KEY
      )
    });
  }
});

router.get('/:serviceId', async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);

    if (!Number.isInteger(serviceId)) {
      return res.status(400).json({
        error: 'Service ID không hợp lệ'
      });
    }

    const services = await getServices(
      false,
      req.app.locals.db
    );

    const service = services.find(
      value => value.service === serviceId
    );

    if (!service) {
      return res.status(404).json({
        error: 'Không tìm thấy dịch vụ'
      });
    }

    return res.json({ service });
  } catch (error) {
    console.error('service detail:', error);

    return res.status(502).json({
      error: 'Không lấy được dịch vụ',
      code: 'PROVIDER_ERROR',
      httpStatus: error?.response?.status ?? null,
      message: error?.message || 'Provider request failed'
    });
  }
});

module.exports = router;
module.exports.getServices = getServices;
module.exports.syncServices = syncServices;
module.exports.normalizeService = normalizeService;
module.exports.fetchProviderServices = fetchProviderServices;
