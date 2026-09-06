'use strict';

const axios = require('axios');

function providerConfig() {
  const rawUrl = String(process.env.PROVIDER_API_URL || '').trim();
  const key = String(process.env.PROVIDER_API_KEY || '').trim();
  if (!rawUrl) throw new Error('PROVIDER_API_URL chưa được cấu hình');
  if (!key) throw new Error('PROVIDER_API_KEY chưa được cấu hình');

  let url = rawUrl.replace(/\s+/g, '').replace(/\/+$/, '');
  // This provider exposes the standard SMM API under /api/v2.
  if (/\/api\/v2$/i.test(url)) url += '/';
  else if (!/\/api\/v2(?:\/|$)/i.test(url)) url += '/api/v2/';

  return { url, key, timeout: Math.min(Math.max(Number(process.env.PROVIDER_TIMEOUT_MS || 20000), 3000), 60000) };
}

function providerError(error, action = 'Provider API') {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const remote = data?.error || data?.message || (typeof data === 'string' ? data.slice(0, 500) : '');
  const code = error?.code || '';
  let message = remote || error?.message || `${action} thất bại`;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') message = `${action} timeout`;
  const out = new Error(String(message).slice(0, 1000));
  out.providerStatus = status || null;
  out.providerCode = code || null;
  out.providerResponse = data == null ? null : data;
  return out;
}

async function providerRequest(params) {
  const cfg = providerConfig();
  const client = axios.create({ baseURL: cfg.url, timeout: cfg.timeout, validateStatus: () => true });
  try {
    const response = await client.post('', new URLSearchParams({ key: cfg.key, ...params }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    });
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { response });
    }
    if (response.data && typeof response.data === 'object' && !Array.isArray(response.data) && response.data.error) {
      throw Object.assign(new Error(String(response.data.error)), { response });
    }
    return response.data;
  } catch (error) {
    throw providerError(error, `Provider action ${params.action || ''}`.trim());
  }
}

async function providerServices() {
  return providerRequest({ action: 'services' });
}

async function providerAddOrder({ service, link, quantity, comments, reaction }) {
  const params = { action: 'add', service: String(service), link: String(link), quantity: String(quantity) };
  if (comments) params.comments = String(comments);
  if (reaction) params.reaction = String(reaction);
  return providerRequest(params);
}

async function providerStatus(order) {
  return providerRequest({ action: 'status', order: String(order) });
}

async function providerCancel(orders) {
  return providerRequest({ action: 'cancel', orders: Array.isArray(orders) ? orders.join(',') : String(orders) });
}

async function providerRefill(orders) {
  return providerRequest({ action: 'refill', orders: Array.isArray(orders) ? orders.join(',') : String(orders) });
}

module.exports = { providerConfig, providerError, providerRequest, providerServices, providerAddOrder, providerStatus, providerCancel, providerRefill };
