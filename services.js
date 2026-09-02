const express = require('express');
const axios = require('axios');

const router = express.Router();
const CACHE_MS = Number(process.env.SERVICE_CACHE_MS || 5 * 60 * 1000);
let cachedServices = null;
let cachedAt = 0;

function providerClient() {
  const baseURL = process.env.PROVIDER_API_URL;
  const key = process.env.PROVIDER_API_KEY;
  if (!baseURL || !key) throw new Error('Provider API is not configured');
  return axios.create({
    baseURL,
    timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
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
  return 'Facebook';
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function normalizeService(row) {
  const service = Number(row.service ?? row.id);
  const name = String(row.name ?? '').trim();
  const category = String(row.category ?? row.type ?? 'Khác').trim();
  const platform = detectPlatform(name, category, row);
  const type = String(row.type ?? 'Default').trim() || 'Default';
  const rateNumber = Number.parseFloat(row.rate ?? 0);
  const minNumber = Number.parseInt(row.min ?? 0, 10);
  const maxNumber = Number.parseInt(row.max ?? 0, 10);
  const cleanDecimal = value => Number(Number(value).toFixed(8)).toString();
  const requestedMode = String(process.env.PROVIDER_RATE_MODE || 'USD_PER_1000').trim().toUpperCase();
  const mode = ['USD_PER_1000','VND_PER_1000','VND_PER_1'].includes(requestedMode) ? requestedMode : 'USD_PER_1000';
  if (!Number.isFinite(service) || !name || !Number.isFinite(rateNumber) || !Number.isFinite(minNumber) || !Number.isFinite(maxNumber) || rateNumber < 0 || minNumber < 0 || maxNumber < minNumber) return null;
  const usdVnd = Number(process.env.USD_VND_RATE || 27000);
  if (!Number.isFinite(usdVnd) || usdVnd <= 0) throw new Error('USD_VND_RATE is invalid');
  let rate;
  if (mode === 'VND_PER_1') {
    rate = cleanDecimal(rateNumber);
  } else if (mode === 'VND_PER_1000') {
    rate = cleanDecimal(rateNumber / 1000);
  } else {
    // Default/provider mode: USD per 1,000. Some panels serialize $0.25 as 250;
    // the two representations are equivalent, so normalize the scaled form.
    const providerUsdPer1000 = rateNumber >= 10 ? rateNumber / 1000 : rateNumber;
    rate = cleanDecimal(providerUsdPer1000 * usdVnd / 1000);
  }
  return {
    service,
    name,
    type,
    platform,
    category,
    rate,
    unitRateVnd: rate,
    providerRate: cleanDecimal(rateNumber),
    providerRateMode: mode,
    min: String(minNumber),
    max: String(maxNumber),
    refill: toBool(row.refill),
    cancel: toBool(row.cancel)
  };
}

async function fetchProviderServices() {
  const client = providerClient();
  const response = await client.post('', new URLSearchParams({
    key: process.env.PROVIDER_API_KEY,
    action: 'services'
  }).toString());
  if (!Array.isArray(response.data)) {
    throw new Error('Provider services response is not an array');
  }
  const normalized = response.data.map(normalizeService).filter(Boolean);
  if (!normalized.length) throw new Error('Provider returned no usable services');
  return normalized;
}

async function getServices(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedServices && now - cachedAt < CACHE_MS) return cachedServices;
  try {
    const fresh = await fetchProviderServices();
    cachedServices = fresh;
    cachedAt = now;
    return fresh;
  } catch (error) {
    // Keep the last known-good provider list during a transient provider/network error.
    if (cachedServices && cachedServices.length) {
      console.error('Provider refresh failed; serving cached services:', error.message);
      return cachedServices;
    }
    throw error;
  }
}

router.get('/', async (req, res) => {
  try {
    const services = await getServices(req.query.refresh === '1');
    res.json({ services, cachedAt });
  } catch (error) {
    console.error('services:', error.message);
    res.status(502).json({ error: 'Không lấy được danh sách dịch vụ từ Provider' });
  }
});

router.get('/:serviceId', async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);
    if (!Number.isInteger(serviceId)) return res.status(400).json({ error: 'Service ID không hợp lệ' });
    const services = await getServices(false);
    const service = services.find(v => v.service === serviceId);
    if (!service) return res.status(404).json({ error: 'Không tìm thấy dịch vụ' });
    res.json({ service });
  } catch (error) {
    console.error('service detail:', error.message);
    res.status(502).json({ error: 'Không lấy được dịch vụ' });
  }
});

module.exports = router;
module.exports.getServices = getServices;
module.exports.normalizeService = normalizeService;
