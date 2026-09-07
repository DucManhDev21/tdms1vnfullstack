'use strict';

const DEFAULT_MARKUP_PERCENT = 0;
const MAX_MARKUP_PERCENT = 1000;
const SUPPORTED_MODES = new Set(['USD_PER_1000', 'MILLI_USD_PER_1000', 'VND_PER_1000', 'VND_PER_1']);

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 10000) / 10000;
}

function parseMarkup(value, fallback = DEFAULT_MARKUP_PERCENT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_MARKUP_PERCENT, Math.max(0, number));
}

function defaultMarkupPercent() {
  return parseMarkup(process.env.SERVICE_MARKUP_PERCENT, DEFAULT_MARKUP_PERCENT);
}

function providerRateMode() {
  const mode = String(process.env.PROVIDER_RATE_MODE || 'USD_PER_1000').trim().toUpperCase();
  return SUPPORTED_MODES.has(mode) ? mode : 'USD_PER_1000';
}

async function getPricingOverrides(db) {
  if (!db) return new Map();
  const snap = await db.collection('service_pricing').get();
  const map = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const fixed = data.fixedUnitRateVnd == null || data.fixedUnitRateVnd === '' ? null : Number(String(data.fixedUnitRateVnd).replace(/,/g, '').trim());
    map.set(String(doc.id), {
      markupPercent: parseMarkup(data.markupPercent, defaultMarkupPercent()),
      fixedUnitRateVnd: fixed != null && Number.isFinite(fixed) && fixed >= 0 ? roundMoney(fixed) : null,
      enabled: data.enabled !== false,
      updatedAt: data.updatedAt || null
    });
  }
  return map;
}

function getProviderUnitRateVnd(service) {
  const candidates = [service?.providerUnitRateVnd, service?.unitRateVnd, service?.provider_unit_rate_vnd, service?.rateVnd];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const value = Number(String(candidate).replace(/,/g, '').trim());
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function applyPricing(service, override = null) {
  const providerUnitRate = getProviderUnitRateVnd(service);
  if (providerUnitRate == null) throw new Error(`Invalid provider rate for service ${service?.service ?? service?.id ?? 'unknown'}`);
  const markupPercent = parseMarkup(override?.markupPercent, defaultMarkupPercent());
  const customNumber = override?.fixedUnitRateVnd == null || override?.fixedUnitRateVnd === '' ? null : Number(override.fixedUnitRateVnd);
  const sellingRate = customNumber != null && Number.isFinite(customNumber) && customNumber >= 0 ? roundMoney(customNumber) : roundMoney(providerUnitRate * (1 + markupPercent / 100));
  return {
    ...service,
    providerUnitRateVnd: roundMoney(providerUnitRate),
    providerRateRaw: service?.providerRate ?? null,
    rate: sellingRate,
    unitRateVnd: sellingRate,
    sellingRateVnd: sellingRate,
    markupPercent,
    fixedUnitRateVnd: customNumber != null && Number.isFinite(customNumber) && customNumber >= 0 ? roundMoney(customNumber) : null,
    enabled: override?.enabled !== false
  };
}

function calculateTotal(rate, quantity) {
  const unitRate = Number(rate);
  const qty = Number(quantity);
  if (!Number.isFinite(unitRate) || unitRate < 0 || !Number.isSafeInteger(qty) || qty <= 0) throw new Error('Giá hoặc số lượng không hợp lệ');
  const total = roundMoney(unitRate * qty);
  if (!Number.isFinite(total) || total < 0) throw new Error('Tổng tiền không hợp lệ');
  return total;
}

module.exports = { DEFAULT_MARKUP_PERCENT, MAX_MARKUP_PERCENT, SUPPORTED_MODES, roundMoney, parseMarkup, defaultMarkupPercent, providerRateMode, getPricingOverrides, getProviderUnitRateVnd, applyPricing, calculateTotal };
