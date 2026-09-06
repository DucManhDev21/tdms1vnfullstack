const express = require('express');
const router = express.Router();
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');

let syncRunning = false;
let serviceSyncRunning = false;

function cronGuard(req, res, next) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const supplied = String(req.get('X-Cron-Secret') || req.query.secret || '').trim();
  if (!supplied || supplied !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}

async function runScheduledSync(db, admin) {
  if (syncRunning) return { skipped: true, reason: 'already-running' };
  syncRunning = true;
  try {
    return await syncOrders({ db, admin, limit: 100 });
  } finally {
    syncRunning = false;
  }
}

async function runScheduledServiceSync(db) {
  if (serviceSyncRunning) return { skipped: true, reason: 'already-running' };
  serviceSyncRunning = true;
  try {
    const services = await syncServices(db, true);
    return { serviceCount: services.length };
  } finally {
    serviceSyncRunning = false;
  }
}

router.get('/sync-orders', (req, res, next) => req.app.locals.verifyToken(req, res, next), async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, limit: req.query.limit });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('user sync orders:', error);
    res.status(500).json({ error: 'Không đồng bộ được đơn hàng' });
  }
});

router.post('/sync-orders', cronGuard, async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, limit: req.query.limit || 100 });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('cron sync orders:', error);
    res.status(500).json({ error: 'Không đồng bộ được đơn hàng' });
  }
});

router.post('/sync-services', cronGuard, async (req, res) => {
  try {
    const services = await syncServices(req.app.locals.db, true);
    res.json({ ok: true, serviceCount: services.length });
  } catch (error) {
    console.error('cron sync services:', error);
    res.status(502).json({ error: 'Không đồng bộ được dịch vụ Provider' });
  }
});

module.exports = router;
module.exports.runScheduledSync = runScheduledSync;
module.exports.runScheduledServiceSync = runScheduledServiceSync;
