'use strict';

const { getServices } = require('./services');
const { roundMoney } = require('./pricing');
const { getStatus: providerStatus } = require('./provider');

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status.includes('complete')) return 'Completed';
  if (status.includes('partial')) return 'Partial';
  if (status.includes('cancel')) return 'Canceled';
  if (status.includes('progress')) return 'In progress';
  return 'Pending';
}

async function settleRefund(db, admin, orderId, nextStatus, remains, reason = '') {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { changed: false, refund: 0 };
    const order = orderSnap.data() || {};
    const safeRemains = Math.min(Math.max(0, Number(order.quantity || 0)), Math.max(0, Number(remains || 0)));

    if (order.refundSettledAt) {
      tx.update(orderRef, {
        status: nextStatus,
        remains: safeRemains,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { changed: false, refund: Number(order.refundAmount || 0) };
    }

    const quantity = Math.max(0, Number(order.quantity || 0));
    const charged = Math.max(0, Number(order.totalPrice || 0));
    const rate = Math.max(0, Number(order.rate || 0));
    const refund = nextStatus === 'Canceled' ? roundMoney(charged) : roundMoney(safeRemains * rate);
    const uid = String(order.uid || '');
    if (!uid) throw new Error('Order has no user UID');

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found while settling refund');
    const oldBalance = Number(userSnap.data()?.balance || 0);
    if (!Number.isFinite(oldBalance) || oldBalance < 0) throw new Error('User balance is invalid while settling refund');
    const newBalance = roundMoney(oldBalance + refund);

    if (refund > 0) {
      tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const logRef = db.collection('balance_logs').doc();
      tx.create(logRef, {
        uid,
        amount: refund,
        type: 'credit',
        reason: `Hoàn tiền ${nextStatus === 'Canceled' ? 'hủy' : 'partial'} đơn ${orderId}: ${String(reason || 'Provider').slice(0, 500)}`,
        oldBalance,
        newBalance,
        orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    tx.update(orderRef, {
      status: nextStatus,
      remains: safeRemains,
      refundAmount: refund,
      refundSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      providerSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelReason: nextStatus === 'Canceled' ? String(reason || '').slice(0, 800) : admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { changed: true, refund, charged, quantity, remains: safeRemains };
  });
}

async function syncOrderDoc(db, admin, doc, serviceMap) {
  const order = doc.data() || {};
  if (!order.providerOrderId) return { skipped: true };
  try {
    const provider = await providerStatus(order.providerOrderId);
    const service = serviceMap.get(String(order.serviceId));
    const fallbackRate = Number(service?.sellingRateVnd ?? service?.unitRateVnd ?? service?.rate ?? order.rate ?? 0);
    const remains = Number.isFinite(provider.remains) ? provider.remains : Number(order.remains || 0);
    let settlement = null;

    if (provider.status === 'Canceled' || provider.status === 'Partial') {
      settlement = await settleRefund(db, admin, doc.id, provider.status, remains, provider.raw?.error || provider.raw?.message || provider.raw?.status || 'Provider status');
    } else {
      await doc.ref.update({
        status: provider.status,
        remains,
        rate: Number.isFinite(fallbackRate) ? fallbackRate : Number(order.rate || 0),
        providerRawStatus: provider.raw,
        providerCharge: provider.charge,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { updated: true, status: provider.status, refund: settlement?.refund || 0 };
  } catch (error) {
    await doc.ref.update({ lastProviderError: String(error.message || 'Provider error').slice(0, 1000), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { updated: false, error: String(error.message || error) };
  }
}

async function syncOrders({ db, admin, uid = null, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const services = await getServices(false, db);
  const serviceMap = new Map(services.map(service => [String(service.service), service]));
  let query = db.collection('orders').where('status', 'in', ['Pending', 'In progress', 'Partial']).limit(uid ? Math.min(safeLimit * 3, 300) : safeLimit);
  if (uid) query = db.collection('orders').where('uid', '==', uid).limit(Math.min(safeLimit * 3, 300));
  const raw = await query.get();
  const docs = uid ? raw.docs.filter(doc => ['Pending', 'In progress', 'Partial'].includes(String(doc.data()?.status))).slice(0, safeLimit) : raw.docs;
  let updated = 0;
  let failed = 0;
  let refunded = 0;
  for (const doc of docs) {
    const result = await syncOrderDoc(db, admin, doc, serviceMap);
    if (result.updated) updated += 1;
    if (result.error) failed += 1;
    refunded += Number(result.refund || 0);
  }
  console.log(`[CRON] Order sync checked=${docs.length} updated=${updated} failed=${failed} refunded=${refunded}`);
  return { checked: docs.length, updated, failed, refunded };
}

module.exports = { providerStatus, normalizeStatus, settleRefund, syncOrderDoc, syncOrders };
