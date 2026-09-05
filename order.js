const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { getServices } = require('./services');
const { calculateTotal, roundMoney } = require('./pricing');

function providerConfig() {
  const baseURL = String(process.env.PROVIDER_API_URL || '').trim();
  const key = String(process.env.PROVIDER_API_KEY || '').trim();
  if (!baseURL || !key) return { configured: false, baseURL, key };
  return { configured: true, baseURL, key };
}

function providerClient() {
  const config = providerConfig();
  if (!config.configured) throw Object.assign(new Error('Provider API is not configured'), { code: 'PROVIDER_NOT_CONFIGURED', definite: true });
  return axios.create({ baseURL: config.baseURL, timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000), validateStatus: () => true });
}

function requireUser(req, res, next) { return req.app.locals.verifyToken(req, res, next); }

function requestId(req) {
  const supplied = String(req.get('Idempotency-Key') || '').trim();
  return supplied || crypto.randomUUID();
}

function parseProviderOrderId(data) {
  const value = data?.order ?? data?.order_id ?? data?.id;
  return value == null ? '' : String(value);
}

function providerError(error, fallback = 'Provider không chấp nhận đơn hàng') {
  const responseData = error?.response?.data;
  if (responseData && typeof responseData === 'object') return String(responseData.error || responseData.message || fallback);
  return String(error?.message || fallback);
}

async function createProviderOrder({ serviceId, link, quantity }) {
  const client = providerClient();
  const body = new URLSearchParams({ key: providerConfig().key, action: 'add', service: String(serviceId), link, quantity: String(quantity) });
  let response;
  try {
    response = await client.post('', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (error) {
    throw Object.assign(new Error(providerError(error, 'Không thể kết nối Provider')), { code: 'PROVIDER_NETWORK_ERROR', definite: false, cause: error });
  }

  const data = response.data || {};
  const providerOrderId = parseProviderOrderId(data);
  if (providerOrderId && response.status >= 200 && response.status < 300) return providerOrderId;

  const message = providerError({ response }, 'Provider không trả về mã đơn hàng');
  const definite = Boolean(data.error || data.errors) || (response.status >= 400 && response.status < 500);
  throw Object.assign(new Error(message), {
    code: definite ? 'PROVIDER_REJECTED' : 'PROVIDER_RESPONSE_UNCERTAIN',
    definite,
    httpStatus: response.status,
    raw: data
  });
}

async function refundFailedOrder({ db, admin, orderId, uid, reason }) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('Không tìm thấy đơn cần hoàn tiền');
    const order = orderSnap.data() || {};
    if (order.refundSettledAt) return { refunded: false, amount: Number(order.refundAmount || 0) };
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('Không tìm thấy tài khoản để hoàn tiền');
    const oldBalance = Number(userSnap.data()?.balance || 0);
    const refund = roundMoney(Number(order.totalPrice || 0));
    const newBalance = roundMoney(oldBalance + refund);
    tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(orderRef, {
      status: 'Canceled',
      remains: Number(order.quantity || 0),
      refundAmount: refund,
      refundSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      providerSubmissionStatus: 'rejected',
      cancelReason: String(reason || 'Provider rejected').slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const logRef = db.collection('balance_logs').doc();
    tx.set(logRef, {
      uid,
      amount: refund,
      type: 'credit',
      reason: `Hoàn tiền đơn ${orderId}: Provider từ chối`,
      oldBalance,
      newBalance,
      orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { refunded: true, amount: refund };
  });
}

router.post('/', requireUser, async (req, res) => {
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const uid = req.user.uid;
  const idem = requestId(req);
  const { serviceId, link, quantity } = req.body || {};
  const parsedServiceId = Number.parseInt(serviceId, 10);
  const parsedQuantity = Number.parseInt(quantity, 10);

  if (!Number.isInteger(parsedServiceId) || !link || !Number.isInteger(parsedQuantity) || parsedQuantity <= 0) return res.status(400).json({ error: 'Thiếu hoặc sai dữ liệu đặt hàng' });
  if (String(link).length > 2000) return res.status(400).json({ error: 'Link quá dài' });
  if (!providerConfig().configured) return res.status(503).json({ ok: false, code: 'PROVIDER_NOT_CONFIGURED', error: 'Provider API chưa được cấu hình.' });

  try {
    const services = await getServices(false, db);
    const service = services.find(v => v.service === parsedServiceId);
    if (!service) return res.status(400).json({ error: 'Dịch vụ không tồn tại' });
    const min = Number.parseInt(service.min, 10);
    const max = Number.parseInt(service.max, 10);
    if (parsedQuantity < min || parsedQuantity > max) return res.status(400).json({ error: `Số lượng phải từ ${min} đến ${max}` });
    const rate = Number.parseFloat(service.unitRateVnd ?? service.rate);
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'Giá dịch vụ không hợp lệ' });
    const totalPrice = calculateTotal(rate, parsedQuantity);
    if (!Number.isFinite(totalPrice) || totalPrice < 0) return res.status(400).json({ error: 'Giá dịch vụ không hợp lệ' });

    const requestDocId = `${uid}_${idem.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
    const idemRef = db.collection('order_requests').doc(requestDocId);
    const reserved = await db.runTransaction(async tx => {
      const existingReq = await tx.get(idemRef);
      if (existingReq.exists) return { duplicate: true, orderId: existingReq.data()?.orderId };
      const userRef = db.collection('users').doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
      const user = userSnap.data() || {};
      const oldBalance = Number(user.balance || 0);
      if (!Number.isFinite(oldBalance) || oldBalance < totalPrice) throw Object.assign(new Error('Số dư không đủ'), { code: 'INSUFFICIENT_BALANCE' });
      const orderRef = db.collection('orders').doc();
      const newBalance = roundMoney(oldBalance - totalPrice);
      tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(orderRef, {
        uid,
        username: String(user.username || ''),
        email: String(user.email || req.user.email || ''),
        serviceId: parsedServiceId,
        serviceName: service.name,
        platform: service.platform,
        category: service.category,
        type: service.type,
        link: String(link).trim(),
        quantity: parsedQuantity,
        totalPrice,
        rate,
        unitRateVnd: rate,
        providerRate: service.providerRate ?? null,
        providerRateMode: service.providerRateMode ?? null,
        providerUnitRateVnd: service.providerUnitRateVnd ?? service.providerRate ?? null,
        sellingRateVnd: service.sellingRateVnd ?? rate,
        markupPercent: service.markupPercent ?? 0,
        fixedUnitRateVnd: service.fixedUnitRateVnd ?? null,
        providerOrderId: '',
        providerSubmissionStatus: 'reserved',
        status: 'Creating',
        remains: parsedQuantity,
        refill: service.refill,
        cancel: service.cancel,
        idempotencyKey: idem,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, { uid, amount: -totalPrice, type: 'debit', reason: `Đặt đơn ${orderRef.id}`, oldBalance, newBalance, orderId: orderRef.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(idemRef, { uid, orderId: orderRef.id, status: 'reserved', createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return { duplicate: false, orderId: orderRef.id };
    });

    if (reserved.duplicate) return res.status(200).json({ ok: true, duplicate: true, orderId: reserved.orderId });

    try {
      const providerOrderId = await createProviderOrder({ serviceId: parsedServiceId, link: String(link).trim(), quantity: parsedQuantity });
      await db.runTransaction(async tx => {
        const orderRef = db.collection('orders').doc(reserved.orderId);
        const reqRef = idemRef;
        const orderSnap = await tx.get(orderRef);
        const reqSnap = await tx.get(reqRef);
        if (!orderSnap.exists) throw new Error('Đơn khởi tạo không tồn tại');
        tx.update(orderRef, { providerOrderId, providerSubmissionStatus: 'accepted', status: 'Pending', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        if (reqSnap.exists) tx.update(reqRef, { status: 'accepted', providerOrderId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.status(201).json({ ok: true, orderId: reserved.orderId, providerOrderId, totalPrice });
    } catch (providerError) {
      console.error('provider create order:', providerError?.code || 'unknown', providerError?.message || providerError);
      if (providerError?.definite === true) {
        try {
          const refund = await refundFailedOrder({ db, admin, orderId: reserved.orderId, uid, reason: providerError.message });
          await idemRef.set({ status: 'rejected', refundAmount: refund.amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          return res.status(502).json({ ok: false, code: 'PROVIDER_REJECTED', error: 'Provider từ chối đơn. Hệ thống đã hoàn tiền 100%.', refunded: true, orderId: reserved.orderId, refund: refund.amount });
        } catch (refundError) {
          console.error('provider rejection refund failed:', refundError);
          return res.status(503).json({ ok: false, code: 'REFUND_PENDING', error: 'Provider từ chối đơn nhưng việc hoàn tiền đang chờ xử lý. Vui lòng không tạo lại đơn với cùng Idempotency-Key.', orderId: reserved.orderId });
        }
      }
      await db.runTransaction(async tx => {
        const orderRef = db.collection('orders').doc(reserved.orderId);
        tx.update(orderRef, {
          status: 'Provider uncertain',
          providerSubmissionStatus: 'unknown',
          providerSubmissionError: String(providerError?.message || 'Unknown Provider error').slice(0, 1000),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.update(idemRef, { status: 'provider_uncertain', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.status(503).json({ ok: false, code: 'PROVIDER_SUBMISSION_UNCERTAIN', error: 'Không xác định được Provider đã nhận đơn hay chưa. Tiền chưa được hoàn tự động để tránh tạo đơn trùng.', orderId: reserved.orderId, requiresReconciliation: true });
    }
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Số dư không đủ' });
    if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    console.error('order create:', error);
    return res.status(500).json({ error: 'Không thể tạo đơn hàng', code: error.code || 'ORDER_CREATE_FAILED' });
  }
});

router.get('/', requireUser, async (req, res) => {
  try {
    const snap = await req.app.locals.db.collection('orders').where('uid', '==', req.user.uid).limit(100).get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ orders });
  } catch (error) {
    console.error('orders list:', error);
    res.status(503).json({ ok: false, code: 'ORDERS_UNAVAILABLE', error: 'Không thể lấy đơn hàng lúc này.' });
  }
});

module.exports = router;
