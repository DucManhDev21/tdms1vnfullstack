'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'Provider request failed'));
    this.name = 'ProviderError';
    this.code = options.code || 'PROVIDER_ERROR';
    this.status = Number.isFinite(Number(options.status)) ? Number(options.status) : null;
    this.providerData = options.providerData ?? null;
    this.cause = options.cause || null;
    this.retryable = options.retryable === true;
  }
}

function providerConfigured() {
  return Boolean(String(process.env.PROVIDER_API_URL || '').trim() && String(process.env.PROVIDER_API_KEY || '').trim());
}

function providerBaseUrl() {
  const raw = String(process.env.PROVIDER_API_URL || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('PROVIDER_API_URL is invalid', { code: 'PROVIDER_CONFIG_ERROR' });
  }
  if (!/^https?:$/.test(url.protocol)) throw new ProviderError('PROVIDER_API_URL must use http or https', { code: 'PROVIDER_CONFIG_ERROR' });
  url.hash = '';
  url.search = '';
  if (!url.pathname || url.pathname === '/') url.pathname = '/api/v2';
  return url.toString().replace(/\/$/, '');
}

function timeoutMs() {
  const value = Number(process.env.PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1000), 120000) : DEFAULT_TIMEOUT_MS;
}

function retries() {
  const value = Number(process.env.PROVIDER_RETRIES || DEFAULT_RETRIES);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), 5) : DEFAULT_RETRIES;
}

function compactBody(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 800);
  try { return JSON.stringify(value).slice(0, 800); } catch { return String(value).slice(0, 800); }
}

async function parseResponse(response) {
  const text = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!text.trim()) return { data: null, rawText: '', contentType };
  if (contentType.includes('application/json')) {
    try { return { data: JSON.parse(text), rawText: text.slice(0, 2000), contentType }; }
    catch { return { data: text, rawText: text.slice(0, 2000), contentType }; }
  }
  try { return { data: JSON.parse(text), rawText: text.slice(0, 2000), contentType }; }
  catch { return { data: text, rawText: text.slice(0, 2000), contentType }; }
}

function extractProviderError(data) {
  if (data && typeof data === 'object') {
    return String(data.error ?? data.message ?? data.description ?? data.detail ?? '').trim();
  }
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return 'Provider returned an empty response';
    if (/^<!doctype html|^<html|<body[ >]/i.test(trimmed)) return 'Provider returned HTML instead of JSON';
    return trimmed.slice(0, 800);
  }
  return '';
}

function shouldRetry(status) {
  if (status == null) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function request(action, fields = {}, options = {}) {
  if (!providerConfigured()) throw new ProviderError('Provider API is not configured', { code: 'PROVIDER_NOT_CONFIGURED' });

  const baseUrl = providerBaseUrl();
  const apiKey = String(process.env.PROVIDER_API_KEY || '').trim();
  const timeout = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : timeoutMs();
  const retryCount = Number.isFinite(Number(options.retries)) ? Math.max(0, Math.trunc(Number(options.retries))) : retries();
  const body = new URLSearchParams({ key: apiKey, action: String(action), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v ?? '')])) });

  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (attempt === 0) console.log(`[PROVIDER] Request action=${action}`);
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal
      });
      const parsed = await parseResponse(response);
      const providerMessage = extractProviderError(parsed.data);
      if (!response.ok) {
        lastError = new ProviderError(
          `Provider HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ''}`,
          { status: response.status, providerData: parsed.data, retryable: shouldRetry(response.status) }
        );
      } else if (providerMessage && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) && ('error' in parsed.data || 'success' in parsed.data && parsed.data.success === false)) {
        lastError = new ProviderError(providerMessage, { status: response.status, providerData: parsed.data, retryable: false });
      } else {
        return parsed.data;
      }
      if (!lastError.retryable || attempt >= retryCount) throw lastError;
    } catch (error) {
      if (error?.name === 'AbortError') {
        lastError = new ProviderError(`Provider request timed out after ${timeout}ms`, { code: 'PROVIDER_TIMEOUT', retryable: true, cause: error });
      } else if (error instanceof ProviderError) {
        lastError = error;
      } else {
        const code = error?.code || error?.cause?.code || 'PROVIDER_NETWORK_ERROR';
        lastError = new ProviderError(`${code}: ${error?.message || 'Provider network error'}`, { code, retryable: true, cause: error });
      }
      if (!lastError.retryable || attempt >= retryCount) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    const backoff = Math.min(3000, 500 * (attempt + 1));
    await sleep(backoff);
  }
  throw lastError || new ProviderError('Provider request failed');
}

function serviceArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.services)) return payload.services;
  if (payload && Array.isArray(payload.data)) return payload.data;
  throw new ProviderError('Provider services response is not an array', { providerData: payload });
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status.includes('complete')) return 'Completed';
  if (status.includes('partial')) return 'Partial';
  if (status.includes('cancel')) return 'Canceled';
  if (status.includes('progress')) return 'In progress';
  if (status.includes('pending')) return 'Pending';
  return 'Pending';
}

async function getServices() {
  return serviceArray(await request('services'));
}

async function addOrder({ serviceId, link, quantity }) {
  const payload = await request('add', {
    service: serviceId,
    link,
    quantity
  });
  const id = payload?.order ?? payload?.order_id ?? payload?.id;
  if (id == null || String(id).trim() === '') {
    const message = extractProviderError(payload) || 'Provider did not return an order id';
    throw new ProviderError(message, { providerData: payload });
  }
  return { providerOrderId: String(id), raw: payload };
}

async function getStatus(providerOrderId) {
  const payload = await request('status', { order: providerOrderId });
  if (!payload || typeof payload !== 'object') throw new ProviderError('Provider status response is invalid', { providerData: payload });
  const remainsNumber = Number.parseInt(payload.remains, 10);
  const chargeNumber = Number.parseFloat(payload.charge);
  return {
    status: normalizeStatus(payload.status),
    remains: Number.isFinite(remainsNumber) ? Math.max(0, remainsNumber) : 0,
    charge: Number.isFinite(chargeNumber) ? chargeNumber : 0,
    raw: payload
  };
}

module.exports = {
  ProviderError,
  providerConfigured,
  providerBaseUrl,
  request,
  getServices,
  addOrder,
  getStatus,
  normalizeStatus,
  extractProviderError
};
