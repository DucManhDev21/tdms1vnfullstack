'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getServices } = require('./services');
const { calculateTotal, roundMoney } = require('./pricing');
const { addOrder } = require('./provider');
const { authRequired } = require('./middleware/auth');

function requestId(req) {
  return String(req.get('Idempotency-Key') || crypto.randomUUID()).trim().slice(0, 120);
}

function safeBalance(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? roundMoney(number) : NaN;
}

function existingOrderResponse(existingReq, db) {
  return db.collection('orders').doc(String(existingReq.orderId)).get().then(snap => {
    if (!snap.exists) return { ok: true, duplicate: true, orderId: String(existingReq.orderId) };
    const order = snap.data() || {};
    return {
      ok: true,
      duplicate: true,
      orderId: snap.id,
      providerOrderId: order.providerOrderId || '',
      totalPrice: Number(order.totalPrice || 0),
      status: String(order.status || 'Pending')
    };
  });
}

router.post('/', authRequired, async (req, res) => {
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const uid = req.user?.uid;
  const body = req.body || {};
  const parsedServiceId = Number.parseInt(body.serviceId, 10);
  const parsedQuantity = Number.parseInt(body.quantity, 10);
  const link = String(body.link || (Array.isArray(body.links) ? body.links[0] || '' : '')).trim();
  const idem = requestId(req);

  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isSafeInteger(parsedServiceId) || !link || !Number.isSafeInteger(parsedQuantity) || parsedQuantity <= 0) {
    return res.status(400).json({ error: 'Thiếu hoặc sai dữ liệu đặt hàng' });
  }
  if (link.length > 2000) return res.status(400).json({ error: 'Link quá dài' });

  try {
    const services = await getServices(false, db);
    const service = services.find(item => Number(item.service) === parsedServiceId);
    if (!service) return res.status(400).json({ error: 'Dịch vụ không tồn tại' });

    const min = Number.parseInt(service.min, 10);
    const max = Number.parseInt(service.max, 10);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || parsedQuantity < min || parsedQuantity > max) {
      return res.status(400).json({ error: `Số lượng phải từ ${min} đến ${max}` });
    }

    const rate = Number.parseFloat(service.sellingRateVnd ?? service.unitRateVnd ?? service.rate);
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'Giá dịch vụ không hợp lệ' });
    const totalPrice = calculateTotal(rate, parsedQuantity);

    const idemKey = idem.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90) || crypto.randomUUID();
    const idemRef = db.collection('order_requests').doc(`${uid}_${idemKey}`);

    const result = await db.runTransaction(async tx => {
      const existingReq = await tx.get(idemRef);
      if (existingReq.exists) return { duplicate: true, existing: existingReq.data() || {} };

      const userRef = db.collection('users').doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });

      const user = userSnap.data() || {};
      const oldBalance = safeBalance(user.balance == null ? 0 : user.balance);
      if (!Number.isFinite(oldBalance)) throw Object.assign(new Error('Số dư hiện tại không hợp lệ'), { code: 'INVALID_BALANCE' });
      if (oldBalance < totalPrice) throw Object.assign(new Error('Số dư không đủ'), { code: 'INSUFFICIENT_BALANCE' });

      const orderRef = db.collection('orders').doc();
      const newBalance = roundMoney(oldBalance - totalPrice);
      tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.create(orderRef, {
        uid,
        username: String(user.username || ''),
        email: String(user.email || req.user.email || ''),
        serviceId: parsedServiceId,
        serviceName: String(service.name || body.serviceName || ''),
        platform: String(service.platform || ''),
        category: String(service.category || ''),
        type: String(service.type || 'Default'),
        link,
        links: Array.isArray(body.links) ? body.links.map(v => String(v).trim()).filter(Boolean).slice(0, 20) : [link],
        quantity: parsedQuantity,
        totalPrice,
        rate,
        unitRateVnd: rate,
        providerRate: service.providerRate ?? null,
        providerRateMode: service.providerRateMode ?? null,
        providerUnitRateVnd: service.providerUnitRateVnd ?? null,
        sellingRateVnd: service.sellingRateVnd ?? rate,
        markupPercent: service.markupPercent ?? 0,
        fixedUnitRateVnd: service.fixedUnitRateVnd ?? null,
        providerOrderId: '',
        providerSubmissionState: 'reserved',
        status: 'Pending',
        remains: parsedQuantity,
        refill: service.refill === true,
        cancel: service.cancel === true,
        idempotencyKey: idem,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const logRef = db.collection('balance_logs').doc();
      tx.create(logRef, {
        uid,
        amount: -totalPrice,
        type: 'debit',
        reason: `Đặt đơn ${orderRef.id}`,
        oldBalance,
        newBalance,
        orderId: orderRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.create(idemRef, {
        uid,
        orderId: orderRef.id,
        totalPrice,
        status: 'reserved',
        idempotencyKey: idem,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { duplicate: false, orderId: orderRef.id };
    });

    if (result.duplicate) {
      return res.status(200).json(await existingOrderResponse(result.existing, db));
    }

    try {
      console.log(`[ORDER] Creating Provider order for local ${result.orderId}, service=${parsedServiceId}, quantity=${parsedQuantity}`);
      const providerResult = await addOrder({ serviceId: parsedServiceId, link, quantity: parsedQuantity });
      await db.runTransaction(async tx => {
        const orderRef = db.collection('orders').doc(result.orderId);
        const idemSnap = await tx.get(idemRef);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) throw new Error('Local order disappeared after reservation');
        tx.update(orderRef, {
          providerOrderId: providerResult.providerOrderId,
          providerRawAdd: providerResult.raw,
          providerSubmissionState: 'submitted',
          status: 'Pending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (idemSnap.exists) tx.update(idemRef, { status: 'submitted', providerOrderId: providerResult.providerOrderId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      console.log(`[ORDER] Provider order created local=${result.orderId} provider=${providerResult.providerOrderId}`);
      return res.status(201).json({ ok: true, orderId: result.orderId, providerOrderId: providerResult.providerOrderId, totalPrice });
    } catch (providerError) {
      console.error(`[ORDER] Provider add failed for local ${result.orderId}:`, providerError.message);
      await refundFailedProviderOrder({ db, admin, uid, orderId: result.orderId, idemRef, providerError });
      return res.status(502).json({
        error: 'Provider lỗi, hệ thống đã hoàn tiền 100%',
        code: 'PROVIDER_ERROR',
        httpStatus: providerError?.status ?? null,
        message: String(providerError?.message || 'Provider add order failed'),
        refunded: true,
        orderId: result.orderId
      });
    }
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Số dư không đủ' });
    if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    if (error.code === 'INVALID_BALANCE') return res.status(400).json({ error: error.message });
    console.error('[ORDER] create failed:', error);
    return res.status(500).json({ error: 'Không thể tạo đơn hàng', code: error.code || 'ORDER_ERROR', message: process.env.NODE_ENV === 'production' ? 'Order creation failed' : String(error.message || error) });
  }
});

async function refundFailedProviderOrder({ db, admin, uid, orderId, idemRef, providerError }) {
  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data() || {};
    if (order.refundSettledAt) return;
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('Không tìm thấy tài khoản để hoàn tiền');
    const oldBalance = safeBalance(userSnap.data()?.balance || 0);
    if (!Number.isFinite(oldBalance)) throw new Error('Số dư hiện tại không hợp lệ khi hoàn tiền');
    const refund = roundMoney(Number(order.totalPrice || 0));
    const newBalance = roundMoney(oldBalance + refund);
    tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(orderRef, {
      status: 'Canceled',
      providerSubmissionState: 'failed_refunded',
      remains: Number(order.quantity || 0),
      refundAmount: refund,
      refundSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelReason: String(providerError?.message || 'Provider error').slice(0, 800),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.update(idemRef, {
      status: 'refunded',
      refundAmount: refund,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const logRef = db.collection('balance_logs').doc();
    tx.create(logRef, {
      uid,
      amount: refund,
      type: 'credit',
      reason: `Hoàn tiền đơn ${orderId}: Provider error`,
      oldBalance,
      newBalance,
      orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

router.get('/', authRequired, async (req, res) => {
  try {
    const snap = await req.app.locals.db.collection('orders').where('uid', '==', req.user.uid).limit(100).get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ orders });
  } catch (error) {
    console.error('[ORDER] list failed:', error);
    res.status(500).json({ error: 'Không thể lấy đơn hàng' });
  }
});

module.exports = router;
module.exports.refundFailedProviderOrder = refundFailedProviderOrder;
