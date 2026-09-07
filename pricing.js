const DEFAULT_MARKUP_PERCENT = 0;
const MAX_MARKUP_PERCENT = 1000;

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10000) / 10000;
}

function parseMarkup(value, fallback = DEFAULT_MARKUP_PERCENT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_MARKUP_PERCENT, Math.max(0, number));
}

function defaultMarkupPercent() {
  return parseMarkup(process.env.SERVICE_MARKUP_PERCENT, DEFAULT_MARKUP_PERCENT);
}

async function getPricingOverrides(db) {
  if (!db) return new Map();
  const snap = await db.collection('service_pricing').get();
  const map = new Map();

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const fixed = data.fixedUnitRateVnd;
    const fixedNumber =
      fixed == null || fixed === ''
        ? null
        : Number(String(fixed).replace(/,/g, '').trim());

    map.set(String(doc.id), {
      markupPercent: parseMarkup(data.markupPercent, defaultMarkupPercent()),
      fixedUnitRateVnd:
        fixedNumber != null && Number.isFinite(fixedNumber) && fixedNumber >= 0
          ? roundMoney(fixedNumber)
          : null,
      enabled: data.enabled !== false,
      updatedAt: data.updatedAt || null
    });
  }

  return map;
}

/*
 * IMPORTANT:
 * The provider catalog contains the provider's unit price under
 * providerUnitRateVnd after normalization. Older versions of this file
 * looked only at unitRateVnd/rate, which could accidentally validate the
 * raw provider rate instead of the already-converted VND/unit value.
 *
 * Keep all accepted aliases here so old/provider catalog formats remain
 * compatible.
 */
function getProviderUnitRateVnd(service) {
  const candidates = [
    service?.providerUnitRateVnd,
    service?.unitRateVnd,
    service?.provider_unit_rate_vnd,
    service?.rateVnd,
    service?.rate
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const number = Number(String(candidate).replace(/,/g, '').trim());
    if (Number.isFinite(number) && number >= 0) return number;
  }

  return null;
}

function applyPricing(service, override = null) {
  const providerUnitRate = getProviderUnitRateVnd(service);

  if (providerUnitRate == null) {
    throw new Error(`Invalid provider rate for service ${service?.service ?? service?.id ?? 'unknown'}`);
  }

  const markupPercent = parseMarkup(
    override?.markupPercent,
    defaultMarkupPercent()
  );

  const customRate = override?.fixedUnitRateVnd;
  const customNumber =
    customRate != null && customRate !== ''
      ? Number(String(customRate).replace(/,/g, '').trim())
      : null;

  const sellingRate =
    customNumber != null && Number.isFinite(customNumber) && customNumber >= 0
      ? roundMoney(customNumber)
      : roundMoney(providerUnitRate * (1 + markupPercent / 100));

  return {
    ...service,
    providerUnitRateVnd: roundMoney(providerUnitRate),
    providerRateRaw: service?.providerRate ?? service?.rate ?? null,
    rate: sellingRate,
    unitRateVnd: sellingRate,
    sellingRateVnd: sellingRate,
    markupPercent,
    fixedUnitRateVnd:
      customNumber != null && Number.isFinite(customNumber) && customNumber >= 0
        ? roundMoney(customNumber)
        : null,
    enabled: override?.enabled !== false
  };
}

function calculateTotal(rate, quantity) {
  const unitRate = Number(rate);
  const qty = Number(quantity);

  if (
    !Number.isFinite(unitRate) ||
    unitRate < 0 ||
    !Number.isSafeInteger(qty) ||
    qty <= 0
  ) {
    throw new Error('Giá hoặc số lượng không hợp lệ');
  }

  const total = roundMoney(unitRate * qty);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error('Tổng tiền không hợp lệ');
  }

  return total;
}

module.exports = {
  DEFAULT_MARKUP_PERCENT,
  MAX_MARKUP_PERCENT,
  roundMoney,
  parseMarkup,
  defaultMarkupPercent,
  getPricingOverrides,
  getProviderUnitRateVnd,
  applyPricing,
  calculateTotal
};
