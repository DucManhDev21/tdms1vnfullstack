const axios = require('axios');
const { getServices } = require('./services');
const { roundMoney } = require('./pricing');

function providerClient() {
  const baseURL = String(process.env.PROVIDER_API_URL || '').trim();
  const key = String(process.env.PROVIDER_API_KEY || '').trim();
  if (!baseURL || !key) throw Object.assign(new Error('Provider API is not configured'), { code: 'PROVIDER_NOT_CONFIGURED' });
  return axios.create({ baseURL, timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000), validateStatus: () => true });
}

function normalizeStatus(value) {
  const status = String(value || '').toLowerCase();
  if (status.includes('complete')) return 'Completed';
  if (status.includes('partial')) return 'Partial';
  if (status.includes('cancel')) return 'Canceled';
  if (status.includes('progress')) return 'In progress';
  return 'Pending';
}

async function providerStatus(providerOrderId) {
  let response;
  try {
    response = await providerClient().post('', new URLSearchParams({ key: process.env.PROVIDER_API_KEY, action: 'status', order: String(providerOrderId) }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (error) {
    throw Object.assign(new Error(error?.message || 'Provider network error'), { code: 'PROVIDER_NETWORK_ERROR', cause: error });
  }
  const data = response.data || {};
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(String(data.error || data.message || `Provider HTTP ${response.status}`)), { code: 'PROVIDER_HTTP_ERROR', httpStatus: response.status, raw: data });
  if (data.error || data.errors) throw Object.assign(new Error(String(data.error || data.errors)), { code: 'PROVIDER_STATUS_ERROR', raw: data });
  const remains = Number.parseInt(data.remains, 10);
  return { status: normalizeStatus(data.status), remains: Number.isFinite(remains) ? Math.max(0, remains) : 0, charge: Number.parseFloat(data.charge ?? 0) || 0, raw: data };
}

async function settleRefund(db, admin, orderId, providerStatus, remains, reason) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { changed: false, refund: 0 };
    const order = orderSnap.data() || {};
    if (order.refundSettledAt) {
      tx.update(orderRef, { status: providerStatus, remains, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { changed: false, refund: Number(order.refundAmount || 0) };
    }
    const quantity = Math.max(0, Number(order.quantity || 0));
    const charged = Math.max(0, Number(order.totalPrice || 0));
    const rate = Math.max(0, Number(order.rate || 0));
    const safeRemains = Math.min(quantity, Math.max(0, Number(remains || 0)));
    const refund = providerStatus === 'Canceled' ? roundMoney(charged) : roundMoney(safeRemains * rate);
    const userRef = db.collection('users').doc(String(order.uid));
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found while settling refund');
    const oldBalance = Number(userSnap.data()?.balance || 0);
    const newBalance = roundMoney(oldBalance + refund);
    if (refund > 0) {
      tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, { uid: order.uid, amount: refund, type: 'credit', reason: `Hoàn tiền ${providerStatus === 'Canceled' ? 'hủy' : 'partial'} đơn ${orderId}: ${reason || 'Provider'}`, oldBalance, newBalance, orderId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    tx.update(orderRef, { status: providerStatus, remains: safeRemains, refundAmount: refund, refundSettledAt: admin.firestore.FieldValue.serverTimestamp(), cancelReason: providerStatus === 'Canceled' ? String(reason || '') : admin.firestore.FieldValue.delete(), providerSettledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { changed: true, refund };
  });
}

async function syncOrderDoc(db, admin, doc, serviceMap) {
  const order = doc.data() || {};
  if (!order.providerOrderId) return { skipped: true };
  try {
    const provider = await providerStatus(order.providerOrderId);
    const service = serviceMap.get(String(order.serviceId));
    const fallbackRate = Number(service?.unitRateVnd ?? service?.rate ?? order.rate ?? 0);
    const remains = Number.isFinite(provider.remains) ? provider.remains : Number(order.remains || 0);
    let settlement = null;
    if (provider.status === 'Canceled' || provider.status === 'Partial') {
      settlement = await settleRefund(db, admin, doc.id, provider.status, remains, provider.raw?.error || provider.raw?.message || 'Provider status');
    } else {
      await doc.ref.update({ status: provider.status, remains, rate: Number.isFinite(fallbackRate) ? fallbackRate : Number(order.rate || 0), providerRawStatus: provider.raw, providerCharge: provider.charge, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return { updated: true, status: provider.status, refund: settlement?.refund || 0 };
  } catch (error) {
    try { await doc.ref.update({ lastProviderError: String(error.message || 'Provider error').slice(0, 1000), updatedAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (updateError) { console.error('syncOrderDoc error state:', updateError); }
    return { updated: false, error: error.message, code: error.code };
  }
}

async function queryOrdersWithoutCompositeIndex(db, { uid, safeLimit }) {
  if (uid) {
    const snap = await db.collection('orders').where('uid', '==', uid).limit(Math.min(safeLimit * 3, 300)).get();
    return snap.docs.filter(doc => ['Pending', 'In progress', 'Partial'].includes(String(doc.data()?.status))).slice(0, safeLimit);
  }
  const snap = await db.collection('orders').where('status', 'in', ['Pending', 'In progress', 'Partial']).limit(safeLimit).get();
  return snap.docs;
}

async function syncOrders({ db, admin, uid = null, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const services = await getServices(false, db);
  const serviceMap = new Map(services.map(service => [String(service.service), service]));
  const docs = await queryOrdersWithoutCompositeIndex(db, { uid, safeLimit });
  let updated = 0, failed = 0, refunded = 0;
  for (const doc of docs) {
    const result = await syncOrderDoc(db, admin, doc, serviceMap);
    if (result.updated) updated += 1;
    if (result.error) failed += 1;
    refunded += Number(result.refund || 0);
  }
  return { checked: docs.length, updated, failed, refunded };
}

module.exports = { providerStatus, normalizeStatus, settleRefund, syncOrderDoc, syncOrders };
