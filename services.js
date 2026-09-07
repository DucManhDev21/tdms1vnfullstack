'use strict';

const express = require('express');
const { getServices: providerGetServices } = require('./provider');
const { applyPricing, defaultMarkupPercent, getPricingOverrides, roundMoney, providerRateMode } = require('./pricing');

const router = express.Router();
const CACHE_MS = (() => {
  const value = Number(process.env.SERVICE_CACHE_MS || 300000);
  return Number.isFinite(value) ? Math.max(1000, value) : 300000;
})();

let cachedServices = null;
let cachedAt = 0;
let refreshPromise = null;
let lastSource = 'none';
let lastError = null;
let lastProviderFetchedAt = 0;

function parseNumber(value, fallback = NaN) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const normalized = String(value).trim().replace(/,/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function detectPlatform(name, category, raw) {
  const text = `${name || ''} ${category || ''} ${raw?.platform || ''}`.toLowerCase();
  if (text.includes('tiktok') || text.includes('tik tok')) return 'TikTok';
  if (text.includes('facebook') || text.includes(' fb ') || text.startsWith('fb ')) return 'Facebook';
  if (text.includes('instagram') || text.includes('ig ')) return 'Instagram';
  if (text.includes('youtube') || text.includes('yt ')) return 'Youtube';
  if (text.includes('telegram') || text.includes('tele ')) return 'Telegram';
  if (text.includes('shopee')) return 'Shopee';
  return String(raw?.platform || '').trim() || 'Khác';
}

function extractProviderRate(row) {
  const candidates = [
    ['providerRate', row?.providerRate],
    ['provider_rate', row?.provider_rate],
    ['cost', row?.cost],
    ['rate', row?.rate],
    ['price', row?.price],
    ['unitRate', row?.unitRate],
    ['unitRateVnd', row?.unitRateVnd]
  ];
  for (const [field, candidate] of candidates) {
    const value = parseNumber(candidate);
    if (Number.isFinite(value) && value >= 0) return { value, field };
  }
  return { value: NaN, field: null };
}

function inputScale(row) {
  const raw = row?.providerRateInputScale ?? row?.providerRateScale ?? row?.rateScale ?? process.env.PROVIDER_RATE_INPUT_SCALE;
  const mode = String(row?.providerRateMode || providerRateMode()).trim().toUpperCase();
  const value = raw == null || raw === '' ? (mode === 'USD_PER_1000' ? 0.001 : 1) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid PROVIDER_RATE_INPUT_SCALE for service ${row?.service ?? row?.id ?? 'unknown'}`);
  return value;
}

function convertProviderRateToVndPerUnit(rateNumber, mode, row = null) {
  if (!Number.isFinite(rateNumber) || rateNumber < 0) return NaN;
  const scale = inputScale(row);
  const normalizedRate = rateNumber * scale;
  if (!Number.isFinite(normalizedRate) || normalizedRate < 0) return NaN;

  if (mode === 'VND_PER_1') return normalizedRate;
  if (mode === 'VND_PER_1000') return normalizedRate / 1000;
  if (mode === 'MILLI_USD_PER_1000') {
    const usdVnd = parseNumber(process.env.USD_VND_RATE || 27000);
    if (!Number.isFinite(usdVnd) || usdVnd <= 0) throw new Error('USD_VND_RATE is invalid');
    return (normalizedRate / 1000) * usdVnd / 1000;
  }
  if (mode === 'USD_PER_1000') {
    const usdVnd = parseNumber(process.env.USD_VND_RATE || 27000);
    if (!Number.isFinite(usdVnd) || usdVnd <= 0) throw new Error('USD_VND_RATE is invalid');
    return normalizedRate * usdVnd / 1000;
  }
  throw new Error(`Unsupported PROVIDER_RATE_MODE: ${mode}`);
}

function normalizeService(row) {
  const service = parseNumber(row?.service ?? row?.id);
  const name = String(row?.name ?? '').trim();
  const category = String(row?.category ?? row?.type ?? 'Khác').trim() || 'Khác';
  const platform = detectPlatform(name, category, row);
  const type = String(row?.type ?? 'Default').trim() || 'Default';
  const rateInfo = extractProviderRate(row);
  const minNumber = Number.parseInt(row?.min ?? 0, 10);
  const maxNumber = Number.parseInt(row?.max ?? 0, 10);
  const mode = String(row?.providerRateMode || providerRateMode()).trim().toUpperCase();

  if (!Number.isSafeInteger(service) || service < 0 || !name || !Number.isFinite(rateInfo.value) || rateInfo.value < 0 || !Number.isFinite(minNumber) || !Number.isFinite(maxNumber) || minNumber < 0 || maxNumber < minNumber) {
    return null;
  }

  const storedProviderUnit = parseNumber(row?.providerUnitRateVnd ?? row?.provider_unit_rate_vnd, NaN);
  const providerUnitRateVnd = Number.isFinite(storedProviderUnit) && storedProviderUnit >= 0
    ? storedProviderUnit
    : convertProviderRateToVndPerUnit(rateInfo.value, mode, row);
  if (!Number.isFinite(providerUnitRateVnd) || providerUnitRateVnd < 0) return null;

  console.log(`[PRICING] Service ${service} providerRate=${rateInfo.value}`);
  console.log(`[PRICING] Service ${service} providerUnitRateVnd=${roundMoney(providerUnitRateVnd)} mode=${mode} inputScale=${inputScale(row)}`);

  return applyPricing({
    service,
    name,
    type,
    platform,
    category,
    providerRate: rateInfo.value,
    providerRateMode: mode,
    providerRateInputScale: inputScale(row),
    providerUnitRateVnd: roundMoney(providerUnitRateVnd),
    min: minNumber,
    max: maxNumber,
    refill: toBool(row?.refill),
    cancel: toBool(row?.cancel),
    providerRateField: rateInfo.field
  });
}

function dedupeEnabled(rows) {
  const unique = [];
  const ids = new Set();
  for (const item of rows) {
    if (!item || !item.enabled || ids.has(item.service)) continue;
    ids.add(item.service);
    unique.push(item);
  }
  return unique;
}

async function fetchProviderServices() {
  console.log('[PROVIDER] Requesting services');
  const raw = await providerGetServices();
  console.log(`[PROVIDER] Received ${raw.length} services`);
  const normalized = [];
  for (const row of raw) {
    try {
      const service = normalizeService(row);
      if (service) normalized.push(service);
      else console.warn(`[SERVICES] Skipping invalid provider service ${row?.service ?? row?.id ?? 'unknown'}`);
    } catch (error) {
      console.warn(`[SERVICES] Skipping invalid provider service ${row?.service ?? row?.id ?? 'unknown'}: ${error.message}`);
    }
  }
  const unique = dedupeEnabled(normalized);
  if (!unique.length) throw new Error('Provider returned no usable services');
  return unique;
}

async function loadCatalogFallback(db) {
  if (!db) return [];
  const snap = await db.collection('service_catalog').limit(1000).get();
  if (snap.empty) return [];
  const overrides = await getPricingOverrides(db);
  const normalized = [];
  for (const doc of snap.docs) {
    try {
      const row = { service: doc.id, ...doc.data() };
      const base = normalizeService(row);
      if (!base) continue;
      const priced = applyPricing(base, overrides.get(String(base.service)));
      if (priced.enabled) normalized.push(priced);
    } catch (error) {
      console.warn(`[SERVICES] Skipping invalid Firestore catalog service ${doc.id}: ${error.message}`);
    }
  }
  return dedupeEnabled(normalized);
}

async function persistCatalog(db, services) {
  if (!db || !services.length) return;
  for (let index = 0; index < services.length; index += 400) {
    const batch = db.batch();
    for (const service of services.slice(index, index + 400)) {
      const ref = db.collection('service_catalog').doc(String(service.service));
      batch.set(ref, { ...service, lastSyncedAt: new Date() }, { merge: true });
    }
    await batch.commit();
  }
  await db.collection('system').doc('serviceSync').set({
    serviceCount: services.length,
    syncedAt: new Date(),
    providerRateMode: providerRateMode(),
    providerRateInputScale: inputScale({ providerRateMode: providerRateMode() }),
    defaultMarkupPercent: defaultMarkupPercent()
  }, { merge: true });
}

async function refreshServices(db) {
  const rawServices = await fetchProviderServices();
  const overrides = await getPricingOverrides(db);
  const priced = rawServices.map(service => applyPricing(service, overrides.get(String(service.service)))).filter(service => service.enabled);
  if (!priced.length) throw new Error('No enabled services after pricing');
  cachedServices = priced;
  cachedAt = Date.now();
  lastProviderFetchedAt = cachedAt;
  lastSource = 'provider';
  lastError = null;
  await persistCatalog(db, priced);
  console.log(`[SERVICES] Returning ${priced.length} services from Provider`);
  return priced;
}

async function getServices(forceRefresh = false, db = null) {
  const now = Date.now();
  if (!forceRefresh && cachedServices?.length && now - cachedAt < CACHE_MS) return cachedServices;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      return await refreshServices(db);
    } catch (error) {
      lastError = error;
      if (cachedServices?.length) {
        lastSource = 'memory-cache';
        console.error('[SERVICES] Provider refresh failed; serving in-memory cache:', error.message);
        return cachedServices;
      }
      try {
        const fallback = await loadCatalogFallback(db);
        if (fallback.length) {
          cachedServices = fallback;
          cachedAt = Date.now();
          lastSource = 'firestore-catalog';
          console.error(`[SERVICES] Provider unavailable; serving Firestore catalog fallback (${fallback.length})`);
          return fallback;
        }
      } catch (fallbackError) {
        console.error('[SERVICES] Firestore catalog fallback failed:', fallbackError.message);
      }
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function getServiceState() {
  return {
    source: lastSource,
    degraded: lastSource !== 'provider',
    cachedAt: cachedAt || null,
    providerFetchedAt: lastProviderFetchedAt || null,
    lastError: lastError ? String(lastError.message || lastError) : null
  };
}

async function syncServices(db, forceRefresh = true) {
  return getServices(forceRefresh, db);
}

router.get('/', async (req, res) => {
  try {
    const services = await getServices(req.query.refresh === '1', req.app.locals.db);
    const state = getServiceState();
    res.set('Cache-Control', 'no-store');
    res.json({
      services,
      cachedAt: state.cachedAt,
      count: services.length,
      defaultMarkupPercent: defaultMarkupPercent(),
      degraded: state.degraded,
      provider: { available: state.source === 'provider' },
      source: state.source
    });
  } catch (error) {
    console.error('[SERVICES] Service endpoint failed:', error);
    const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 502;
    res.status(status >= 400 && status <= 599 ? status : 502).json({
      error: 'Không lấy được danh sách dịch vụ từ Provider',
      code: error?.code || 'PROVIDER_ERROR',
      httpStatus: error?.status ?? null,
      message: String(error?.message || 'Provider request failed'),
      providerConfigured: Boolean(String(process.env.PROVIDER_API_URL || '').trim() && String(process.env.PROVIDER_API_KEY || '').trim())
    });
  }
});

router.get('/:serviceId', async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);
    if (!Number.isSafeInteger(serviceId)) return res.status(400).json({ error: 'Service ID không hợp lệ' });
    const services = await getServices(false, req.app.locals.db);
    const service = services.find(item => item.service === serviceId);
    if (!service) return res.status(404).json({ error: 'Không tìm thấy dịch vụ' });
    res.json({ service });
  } catch (error) {
    console.error('[SERVICES] Service detail failed:', error);
    res.status(502).json({ error: 'Không lấy được dịch vụ', code: error?.code || 'PROVIDER_ERROR', httpStatus: error?.status ?? null, message: String(error?.message || 'Provider request failed') });
  }
});

module.exports = router;
module.exports.getServices = getServices;
module.exports.syncServices = syncServices;
module.exports.normalizeService = normalizeService;
module.exports.fetchProviderServices = fetchProviderServices;
module.exports.getServiceState = getServiceState;
module.exports.convertProviderRateToVndPerUnit = convertProviderRateToVndPerUnit;
