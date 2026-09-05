const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function cronGuard(req, res, next) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const supplied = String(req.get('X-Cron-Secret') || req.query.secret || '').trim();
  if (!supplied || supplied !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}

function leaseMs() {
  const parsed = Number(process.env.CRON_LOCK_LEASE_MS || DEFAULT_LEASE_MS);
  return Number.isFinite(parsed) && parsed >= 60000 ? Math.min(parsed, 60 * 60 * 1000) : DEFAULT_LEASE_MS;
}

async function releaseLock(db, admin, ref, owner) {
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.owner === owner) tx.delete(ref);
  }).catch(error => console.error('cron lock release:', error?.message || error));
}

async function withFirestoreLock(db, admin, name, task) {
  const ref = db.collection('system_locks').doc(name);
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  const duration = leaseMs();
  const acquired = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() || {} : {};
    const untilMillis = current.lockedUntil?.toMillis ? current.lockedUntil.toMillis() : Number(current.lockedUntilMillis || 0);
    if (current.active === true && untilMillis > Date.now()) return false;
    const now = admin.firestore.Timestamp.fromMillis(Date.now());
    const until = admin.firestore.Timestamp.fromMillis(Date.now() + duration);
    tx.set(ref, { active: true, owner, job: name, acquiredAt: now, lockedUntil: until, updatedAt: now }, { merge: true });
    return true;
  });

  if (!acquired) return { skipped: true, reason: 'already-running', lock: name };

  let heartbeat;
  try {
    heartbeat = setInterval(() => {
      const now = Date.now();
      const until = admin.firestore.Timestamp.fromMillis(now + duration);
      db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data()?.owner === owner) {
          tx.update(ref, { lockedUntil: until, updatedAt: admin.firestore.Timestamp.fromMillis(now) });
        }
      }).catch(error => console.error(`cron lock heartbeat ${name}:`, error?.message || error));
    }, Math.max(30000, Math.floor(duration / 3))).unref();

    return await task();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseLock(db, admin, ref, owner);
  }
}

async function runScheduledSync(db, admin) {
  return withFirestoreLock(db, admin, 'order-sync', () => syncOrders({ db, admin, limit: 100 }));
}

async function runScheduledServiceSync(db, admin) {
  return withFirestoreLock(db, admin, 'service-sync', async () => {
    const services = await syncServices(db, true);
    return { serviceCount: services.length };
  });
}

router.get('/sync-orders', (req, res, next) => req.app.locals.verifyToken(req, res, next), async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, limit: req.query.limit });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('user sync orders:', error);
    res.status(503).json({ ok: false, code: 'ORDER_SYNC_UNAVAILABLE', error: 'Không đồng bộ được đơn hàng lúc này.' });
  }
});

router.post('/sync-orders', cronGuard, async (req, res) => {
  try {
    const result = await withFirestoreLock(req.app.locals.db, req.app.locals.admin, 'order-sync', () => syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, limit: req.query.limit || 100 }));
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('cron sync orders:', error);
    res.status(503).json({ ok: false, code: 'ORDER_SYNC_UNAVAILABLE', error: 'Không đồng bộ được đơn hàng lúc này.' });
  }
});

router.post('/sync-services', cronGuard, async (req, res) => {
  try {
    const result = await withFirestoreLock(req.app.locals.db, req.app.locals.admin, 'service-sync', async () => {
      const services = await syncServices(req.app.locals.db, true);
      return { serviceCount: services.length };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('cron sync services:', error);
    res.status(503).json({ ok: false, code: 'SERVICE_SYNC_UNAVAILABLE', error: 'Provider/service sync tạm thời không khả dụng.' });
  }
});

module.exports = router;
module.exports.withFirestoreLock = withFirestoreLock;
module.exports.runScheduledSync = runScheduledSync;
module.exports.runScheduledServiceSync = runScheduledServiceSync;
