'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');
const { authRequired } = require('./middleware/auth');

let syncRunning = false;
let serviceSyncRunning = false;

function cronGuard(req, res, next) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured', code: 'CRON_NOT_CONFIGURED', message: 'CRON_SECRET is required for protected cron operations.' });
  const supplied = String(req.get('X-Cron-Secret') || '').trim();
  if (!supplied) return res.status(401).json({ error: 'Invalid cron secret' });
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}

async function runScheduledSync(db, admin) {
  if (syncRunning) return { skipped: true, reason: 'already-running' };
  syncRunning = true;
  try { return await syncOrders({ db, admin, limit: 100 }); }
  finally { syncRunning = false; }
}

async function runScheduledServiceSync(db) {
  if (serviceSyncRunning) return { skipped: true, reason: 'already-running' };
  serviceSyncRunning = true;
  try {
    const services = await syncServices(db, true);
    return { serviceCount: services.length };
  } finally { serviceSyncRunning = false; }
}

router.get('/sync-orders', authRequired, async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, limit: req.query.limit });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[CRON] user sync orders:', error);
    res.status(500).json({ error: 'Không đồng bộ được đơn hàng', code: error.code || 'ORDER_SYNC_ERROR', message: String(error.message || error) });
  }
});

router.post('/sync-orders', cronGuard, async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, limit: req.query.limit || 100 });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[CRON] sync orders:', error);
    res.status(500).json({ error: 'Không đồng bộ được đơn hàng', code: error.code || 'ORDER_SYNC_ERROR', message: String(error.message || error) });
  }
});

router.post('/sync-services', cronGuard, async (req, res) => {
  try {
    const services = await syncServices(req.app.locals.db, true);
    res.json({ ok: true, serviceCount: services.length });
  } catch (error) {
    console.error('[CRON] sync services:', error);
    res.status(502).json({ error: 'Không đồng bộ được dịch vụ Provider', code: error.code || 'PROVIDER_ERROR', message: String(error.message || error) });
  }
});

module.exports = router;
module.exports.runScheduledSync = runScheduledSync;
module.exports.runScheduledServiceSync = runScheduledServiceSync;
module.exports.cronGuard = cronGuard;
