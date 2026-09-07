'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const servicesRouter = require('./services');
const orderRouter = require('./order');
const cronRouter = require('./cron');
const depositRouter = require('./deposit');
const servicesModule = require('./services');
const cronModule = require('./cron');
const { verifyFirebaseToken } = require('./middleware/auth');
const { providerConfigured, getServices: providerServices } = require('./provider');
const { getPricingOverrides, parseMarkup, roundMoney, providerRateMode } = require('./pricing');
const { startAdminBot, handleUpdate: handleTelegramUpdate } = require('./admin-bot');
const { ensureOwnerAdmin, isAdmin, listAdmins, addAdmin, deleteAdmin } = require('./admins');

const app = express();
const PORT = Number(process.env.PORT || 8080);

function initializeFirebase() {
  if (admin.apps.length) return;

  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
    }
    if (serviceAccount.private_key) serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');
    if (serviceAccount.private_key) serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }

  const legacyRaw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (legacyRaw) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(legacyRaw);
    } catch (error) {
      throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT: ${error.message}`);
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if (projectId && clientEmail && privateKeyRaw) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKeyRaw.replace(/\\n/g, '\n')
      })
    });
    return;
  }

  throw new Error('Firebase is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
}

initializeFirebase();

const db = admin.firestore();
const auth = admin.auth();
app.locals.db = db;
app.locals.auth = auth;
app.locals.admin = admin;
app.locals.verifyToken = verifyFirebaseToken;

app.set('trust proxy', 1);
app.disable('x-powered-by');

const defaultOrigins = ['https://tdms1vip.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
const configuredOrigins = String(process.env.CORS_ORIGINS || '').split(',').map(v => v.trim().replace(/\/$/, '')).filter(Boolean);
const allowedCorsOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);
for (const origin of defaultOrigins) allowedCorsOrigins.add(origin);
if (configuredOrigins.includes('*')) allowedCorsOrigins.add('*');
function allowedOrigin(origin) { return !origin || allowedCorsOrigins.has('*') || allowedCorsOrigins.has(origin); }

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use((req, res, next) => {
  const origin = String(req.get('Origin') || '').trim();
  if (allowedOrigin(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    else if (allowedCorsOrigins.has('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Cron-Secret, X-Telegram-Bot-Api-Secret-Token, X-Deposit-Signature');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    if (!allowedOrigin(origin)) return res.status(403).json({ error: 'CORS origin denied', code: 'CORS_ORIGIN_DENIED' });
    return res.status(204).end();
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, allowedOrigin(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Cron-Secret', 'X-Telegram-Bot-Api-Secret-Token', 'X-Deposit-Signature'],
  credentials: false,
  maxAge: 86400
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests', code: 'RATE_LIMITED' } });
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests', code: 'RATE_LIMITED' } });
app.use('/api', publicLimiter);
app.use('/api/orders', mutationLimiter);
app.use('/api/deposits', mutationLimiter);

function serializeValue(value) {
  if (value == null) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = serializeValue(child);
    return output;
  }
  return value;
}
function serializeDoc(doc) { return serializeValue({ id: doc.id, ...doc.data() }); }
function serializeData(data) { return serializeValue(data || {}); }
function nowIso() { return new Date().toISOString(); }
function configuredTelegram() { return Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim()); }
function configuredFirebase() { return Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim() || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)); }

async function ensureUserProfile(uid, email, data = {}) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() || {} : {};
  if (!snap.exists) {
    await ref.set({ uid, email: String(email || ''), balance: 0, role: 'user', displayName: String(data.displayName || ''), photoURL: String(data.photoURL || ''), createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  } else {
    await ref.set({ uid, email: existing.email || String(email || ''), displayName: data.displayName || existing.displayName || '', photoURL: data.photoURL || existing.photoURL || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  return ref;
}

async function requireAdmin(req, res, next) {
  try {
    const email = String(req.user?.email || '').trim().toLowerCase();
    if (!email || !(await isAdmin(db, email))) return res.status(403).json({ ok: false, error: 'Bạn không có quyền Admin.' });
    next();
  } catch (error) {
    console.error('[AUTH] requireAdmin:', error);
    res.status(500).json({ ok: false, error: 'Không thể kiểm tra quyền Admin.', code: error.code || 'ADMIN_CHECK_ERROR' });
  }
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'tdms1vn-backend', version: '13.1.0', time: nowIso() }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'tdms1vn-backend', version: '13.1.0', providerConfigured: providerConfigured(), firebaseConfigured: configuredFirebase(), telegramConfigured: configuredTelegram(), time: nowIso() }));
app.get('/api/ping', (req, res) => res.json({ ok: true, time: nowIso() }));

app.get('/api/system/status', async (req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, api: 'online', firestore: 'online', adminTelegramBot: configuredTelegram(), providerConfigured: providerConfigured(), pricing: { providerRateMode: providerRateMode(), displayUnit: 'VND/1', defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) }, time: nowIso() });
  } catch (error) {
    console.error('[SERVER] system status:', error);
    res.status(503).json({ ok: false, api: 'online', firestore: 'error', error: 'Firestore unavailable', code: 'FIRESTORE_ERROR', message: error.message });
  }
});

app.get('/api', (req, res) => res.json({ ok: true, service: 'tdms1vn-backend', version: '13.1.0', frontend: 'https://tdms1vip.vercel.app', endpoints: ['/api/health', '/api/config/public', '/api/public/stats', '/api/services', '/api/orders', '/api/deposits', '/api/balance-logs', '/api/me', '/api/auth/profile', '/api/account/profile', '/api/admin/provider/test', '/api/cron/sync-orders'] }));

app.get('/api/admin/session', verifyFirebaseToken, async (req, res) => {
  try {
    const userRecord = await auth.getUser(req.user.uid);
    const email = String(userRecord.email || '').trim().toLowerCase();
    if (!email) return res.status(403).json({ ok: false, error: 'Tài khoản chưa có email.' });
    if (userRecord.disabled) return res.status(403).json({ ok: false, error: 'Tài khoản đã bị vô hiệu hóa.' });
    if (!userRecord.emailVerified) return res.status(403).json({ ok: false, error: 'Gmail chưa được xác minh trên Firebase.' });
    if (!(await isAdmin(db, email))) return res.status(403).json({ ok: false, error: 'Tài khoản này không nằm trong danh sách Admin.' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, admin: true, uid: userRecord.uid, email: userRecord.email });
  } catch (error) {
    console.error('[AUTH] admin session:', error);
    res.status(403).json({ ok: false, error: 'Không thể xác thực phiên Admin.' });
  }
});

app.get('/api/admin/admins', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const items = await listAdmins(db); res.json({ ok: true, total: items.length, items }); }
  catch (error) { console.error('[SERVER] admin list:', error); res.status(500).json({ ok: false, error: 'Không thể tải danh sách Admin.' }); }
});
app.post('/api/admin/admins', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const email = String(req.body?.email || '').trim(); if (!email) return res.status(400).json({ ok: false, error: 'Vui lòng nhập email Admin.' }); const item = await addAdmin(db, admin, email, { source: 'web_admin', email: req.user.email || '', uid: req.user.uid }); res.status(201).json({ ok: true, item }); }
  catch (error) { console.error('[SERVER] admin add:', error); res.status(400).json({ ok: false, error: error.message || 'Không thể thêm Admin.' }); }
});
app.delete('/api/admin/admins/:email', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const email = decodeURIComponent(String(req.params.email || '')).trim(); const deleted = await deleteAdmin(db, admin, email, { source: 'web_admin', email: req.user.email || '', uid: req.user.uid }); res.json({ ok: true, email: deleted }); }
  catch (error) { console.error('[SERVER] admin delete:', error); res.status(400).json({ ok: false, error: error.message || 'Không thể xóa Admin.' }); }
});

app.get('/api/admin/audit-logs', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 300); const snap = await db.collection('admin_audit_logs').limit(limit).get(); res.json({ ok: true, total: snap.size, items: snap.docs.map(serializeDoc) }); }
  catch (error) { console.error('[SERVER] admin audit:', error); res.status(500).json({ ok: false, error: 'Không thể tải nhật ký Admin.' }); }
});
app.get('/api/admin/balance-logs', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 300); const snap = await db.collection('balance_logs').limit(limit).get(); res.json({ ok: true, total: snap.size, items: snap.docs.map(serializeDoc) }); }
  catch (error) { console.error('[SERVER] admin balance logs:', error); res.status(500).json({ ok: false, error: 'Không thể tải biến động số dư.' }); }
});
app.get('/api/admin/system', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const [healthSnap, syncSnap, admins] = await Promise.all([db.collection('system').doc('health').get(), db.collection('system').doc('serviceSync').get(), listAdmins(db)]);
    const recentAudit = await db.collection('admin_audit_logs').limit(10).get();
    res.json({ ok: true, api: { version: '13.1.0', node: process.version, environment: process.env.NODE_ENV || 'production' }, firebase: { projectId: process.env.FIREBASE_PROJECT_ID || null, configured: configuredFirebase() }, provider: { configured: providerConfigured(), baseUrl: process.env.PROVIDER_API_URL || null }, telegram: { configured: configuredTelegram(), chatConfigured: Boolean(String(process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim()) }, cors: { origins: Array.from(allowedCorsOrigins).filter(value => value !== '*') }, pricing: { mode: providerRateMode(), inputScale: Number(process.env.PROVIDER_RATE_INPUT_SCALE || 0.001), defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) }, bank: { accountName: process.env.BANK_ACCOUNT_NAME || '', accountNumber: process.env.BANK_ACCOUNT_NUMBER || '', bankBin: process.env.BANK_BIN || '' }, serviceSync: syncSnap.exists ? serializeData(syncSnap.data()) : {}, healthDoc: healthSnap.exists ? serializeData(healthSnap.data()) : {}, adminCount: admins.length, recentAudit: recentAudit.docs.map(serializeDoc) });
  } catch (error) { console.error('[SERVER] admin system:', error); res.status(500).json({ ok: false, error: 'Không thể tải thông tin hệ thống.' }); }
});

app.get('/api/admin/users', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 200); const snap = await db.collection('users').limit(limit).get(); res.json({ ok: true, total: snap.size, items: snap.docs.map(serializeDoc) }); }
  catch (error) { console.error('[SERVER] admin users:', error); res.status(500).json({ ok: false, error: 'Không thể tải người dùng.' }); }
});
app.get('/api/admin/orders', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 200); const snap = await db.collection('orders').limit(limit).get(); res.json({ ok: true, total: snap.size, items: snap.docs.map(serializeDoc) }); }
  catch (error) { console.error('[SERVER] admin orders:', error); res.status(500).json({ ok: false, error: 'Không thể tải đơn hàng.' }); }
});
app.post('/api/admin/orders/sync', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const result = await cronModule.runScheduledSync(db, admin); res.json({ ok: true, ...result }); }
  catch (error) { console.error('[SERVER] admin orders sync:', error); res.status(500).json({ ok: false, error: 'Không đồng bộ được đơn hàng.', code: error.code || 'ORDER_SYNC_ERROR', message: error.message }); }
});
app.get('/api/admin/deposits', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 200); const snap = await db.collection('deposits').limit(limit).get(); const items = snap.docs.map(serializeDoc).map(item => { delete item.code; return item; }); res.json({ ok: true, total: items.length, items }); }
  catch (error) { console.error('[SERVER] admin deposits:', error); res.status(500).json({ ok: false, error: 'Không thể tải yêu cầu nạp tiền.' }); }
});
app.get('/api/admin/popups', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const snap = await db.collection('popups').limit(50).get(); res.json({ ok: true, total: snap.size, items: snap.docs.map(serializeDoc) }); }
  catch (error) { console.error('[SERVER] admin popups:', error); res.status(500).json({ ok: false, error: 'Không thể tải Popup.' }); }
});
app.post('/api/admin/popups', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim(); const title = String(req.body?.title || 'Thông Báo Chung').trim(); const content = String(req.body?.content || ''); const active = req.body?.active !== false;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: 'ID Popup không hợp lệ.' });
    if (!title || title.length > 200 || !content || content.length > 5000) return res.status(400).json({ ok: false, error: 'Tiêu đề hoặc nội dung không hợp lệ.' });
    await db.collection('popups').doc(id).set({ id, title, content, active, updatedAt: admin.firestore.FieldValue.serverTimestamp(), createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.status(201).json({ ok: true, id });
  } catch (error) { console.error('[SERVER] admin popup write:', error); res.status(500).json({ ok: false, error: 'Không thể lưu Popup.' }); }
});
app.delete('/api/admin/popups/:id', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const id = String(req.params.id || '').trim(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: 'ID Popup không hợp lệ.' }); await db.collection('popups').doc(id).delete(); res.json({ ok: true }); }
  catch (error) { console.error('[SERVER] admin popup delete:', error); res.status(500).json({ ok: false, error: 'Không thể xóa Popup.' }); }
});
app.post('/api/admin/users/balance', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || '').replace(/^@/, '').trim(); const amount = Number(req.body?.amount); const reason = String(req.body?.reason || 'Admin web điều chỉnh số dư').trim().slice(0, 200);
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username) || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000000) return res.status(400).json({ ok: false, error: 'Username hoặc số tiền không hợp lệ.' });
    const key = username.toLowerCase(); const map = await db.collection('usernames').doc(key).get(); let uid = map.exists ? String(map.data()?.uid || '') : '';
    if (!uid) { const exact = await db.collection('users').where('usernameLower', '==', key).limit(1).get(); if (exact.empty) return res.status(404).json({ ok: false, error: 'Không tìm thấy username.' }); uid = exact.docs[0].id; }
    const userRef = db.collection('users').doc(uid);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef); if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
      const data = snap.data() || {}; const oldBalance = Number(data.balance || 0); if (!Number.isFinite(oldBalance)) throw new Error('Số dư hiện tại không hợp lệ.');
      const newBalance = roundMoney(oldBalance + amount); if (newBalance < 0) throw new Error('Không thể trừ quá số dư hiện tại.');
      const logRef = db.collection('balance_logs').doc();
      tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.create(logRef, { uid, amount, type: amount > 0 ? 'credit' : 'debit', reason, oldBalance, newBalance, adminAction: 'web_admin', adminUid: req.user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return { username: String(data.username || username), email: String(data.email || ''), oldBalance, newBalance };
    });
    res.json({ ok: true, balance: result.newBalance, ...result });
  } catch (error) { console.error('[SERVER] admin balance:', error); res.status(400).json({ ok: false, error: error.message || 'Không thể điều chỉnh số dư.' }); }
});

async function adminDashboard() {
  const [usersSnap, ordersSnap, depositsSnap, popupsSnap] = await Promise.all([db.collection('users').get(), db.collection('orders').get(), db.collection('deposits').get(), db.collection('popups').get()]);
  let completed = 0, processing = 0, canceled = 0, orderRevenue = 0, completedRevenue = 0, depositCredited = 0;
  for (const doc of ordersSnap.docs) {
    const data = doc.data() || {}; const status = String(data.status || '').trim().toLowerCase(); const value = Number(data.totalPrice || 0);
    if (status === 'completed') completed += 1; else if (['pending', 'in progress', 'partial', 'processing'].includes(status)) processing += 1; else if (['canceled', 'cancelled'].includes(status)) canceled += 1;
    if (Number.isFinite(value) && value >= 0) { orderRevenue += value; if (status === 'completed') completedRevenue += value; }
  }
  for (const doc of depositsSnap.docs) { const data = doc.data() || {}; const value = Number(data.creditedAmount || 0); const status = String(data.status || '').trim().toLowerCase(); if (['thành công', 'approved', 'completed'].includes(status) && Number.isFinite(value)) depositCredited += value; }
  return { users: usersSnap.size, orders: ordersSnap.size, deposits: depositsSnap.size, popups: popupsSnap.size, completed, processing, canceled, orderRevenue: roundMoney(orderRevenue), completedRevenue: roundMoney(completedRevenue), approvedDepositCredit: roundMoney(depositCredited), warnings: [] };
}

app.get('/api/admin/dashboard', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const dashboard = await adminDashboard(); const syncSnap = await db.collection('system').doc('serviceSync').get(); res.json({ ok: true, ...dashboard, serviceSync: syncSnap.exists ? serializeData(syncSnap.data()) : {} }); }
  catch (error) { console.error('[SERVER] admin dashboard:', error); res.status(500).json({ ok: false, error: 'Không thể tải dashboard Admin.', code: error.code || 'ADMIN_DASHBOARD_ERROR' }); }
});

app.get('/api/admin/services', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const services = await servicesModule.getServices(req.query.refresh === '1', db); const overrides = await getPricingOverrides(db); const items = services.map(service => ({ ...service, pricingOverride: overrides.get(String(service.service)) || null })); res.json({ ok: true, total: items.length, items, defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) }); }
  catch (error) { console.error('[SERVER] admin services:', error); res.status(502).json({ ok: false, error: 'Không thể tải service catalog.', code: error.code || 'PROVIDER_ERROR', message: error.message }); }
});
app.post('/api/admin/services/sync', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const services = await servicesModule.syncServices(db, true); res.json({ ok: true, serviceCount: services.length, markupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0), syncedAt: nowIso() }); }
  catch (error) { console.error('[SERVER] admin service sync:', error); res.status(502).json({ ok: false, error: 'Không đồng bộ được dịch vụ từ Provider.', code: error.code || 'PROVIDER_ERROR', message: error.message }); }
});
app.post('/api/admin/services/:serviceId/pricing', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10); if (!Number.isSafeInteger(serviceId)) return res.status(400).json({ ok: false, error: 'Service ID không hợp lệ.' });
    const markupPercent = parseMarkup(req.body?.markupPercent, Number(process.env.SERVICE_MARKUP_PERCENT || 0));
    let fixedUnitRateVnd = null;
    if (req.body?.fixedUnitRateVnd !== undefined && req.body?.fixedUnitRateVnd !== null && String(req.body.fixedUnitRateVnd).trim() !== '') { fixedUnitRateVnd = Number(req.body.fixedUnitRateVnd); if (!Number.isFinite(fixedUnitRateVnd) || fixedUnitRateVnd < 0) return res.status(400).json({ ok: false, error: 'Giá bán cố định không hợp lệ.' }); fixedUnitRateVnd = roundMoney(fixedUnitRateVnd); }
    const enabled = req.body?.enabled !== false;
    await db.collection('service_pricing').doc(String(serviceId)).set({ serviceId, markupPercent, fixedUnitRateVnd, enabled, updatedBy: req.user.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await db.collection('admin_audit_logs').add({ action: 'service_pricing_update', serviceId, markupPercent, fixedUnitRateVnd, enabled, adminUid: req.user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await servicesModule.syncServices(db, true);
    res.json({ ok: true, serviceId, markupPercent, fixedUnitRateVnd, enabled });
  } catch (error) { console.error('[SERVER] admin pricing:', error); res.status(500).json({ ok: false, error: 'Không thể cập nhật giá dịch vụ.' }); }
});
app.delete('/api/admin/services/:serviceId/pricing', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const serviceId = Number.parseInt(req.params.serviceId, 10); if (!Number.isSafeInteger(serviceId)) return res.status(400).json({ ok: false, error: 'Service ID không hợp lệ.' }); await db.collection('service_pricing').doc(String(serviceId)).delete(); await db.collection('admin_audit_logs').add({ action: 'service_pricing_reset', serviceId, adminUid: req.user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() }); await servicesModule.syncServices(db, true); res.json({ ok: true, serviceId }); }
  catch (error) { console.error('[SERVER] admin pricing reset:', error); res.status(500).json({ ok: false, error: 'Không thể đặt lại giá dịch vụ.' }); }
});

app.get('/api/admin/provider/test', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const services = await providerServices(); res.json({ ok: true, providerConfigured: true, servicesCount: services.length }); }
  catch (error) { console.error('[PROVIDER] admin test:', error); res.status(502).json({ ok: false, providerConfigured: providerConfigured(), servicesCount: 0, error: 'Không thể kết nối Provider', code: error.code || 'PROVIDER_ERROR', httpStatus: error.status ?? null, message: error.message }); }
});
app.post('/api/admin/provider/test', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try { const services = await providerServices(); res.json({ ok: true, providerConfigured: true, servicesCount: services.length }); }
  catch (error) { console.error('[PROVIDER] admin test:', error); res.status(502).json({ ok: false, providerConfigured: providerConfigured(), servicesCount: 0, error: 'Không thể kết nối Provider', code: error.code || 'PROVIDER_ERROR', httpStatus: error.status ?? null, message: error.message }); }
});

app.get('/api/public/stats', async (req, res) => {
  try { const [users, orders, completed] = await Promise.all([db.collection('users').count().get(), db.collection('orders').count().get(), db.collection('orders').where('status', '==', 'Completed').count().get()]); res.json({ users: users.data().count, orders: orders.data().count, completed: completed.data().count }); }
  catch (error) { console.error('[SERVER] public stats:', error); res.status(500).json({ error: 'Không lấy được thống kê', code: 'STATS_ERROR' }); }
});

app.get('/api/config/public', (req, res) => {
  res.json({ telegram: process.env.ADMIN_TELEGRAM_HANDLE || '', email: process.env.ADMIN_EMAIL || '', bank: { bankBin: process.env.BANK_BIN || '', accountNumber: process.env.BANK_ACCOUNT_NUMBER || '', accountName: process.env.BANK_ACCOUNT_NAME || '', qrTemplate: process.env.BANK_QR_TEMPLATE || 'compact2' }, currency: process.env.CURRENCY || 'VND', cardTypes: String(process.env.CARD_TYPES || 'Viettel,Vinaphone,Mobifone,Vietnamobile,Zing,Gate,Garena').split(',').map(v => v.trim()).filter(Boolean), cardDenominations: String(process.env.CARD_DENOMINATIONS || '10000,20000,30000,50000,100000,200000,300000,500000,1000000').split(',').map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isInteger(v) && v > 0), cardDiscountPercent: Number(process.env.CARD_DISCOUNT_PERCENT || 30), bankCreditPercent: 100, pricing: { providerRateMode: providerRateMode(), displayUnit: 'VND/1', defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) }, adminTelegramBot: configuredTelegram() });
});

app.use('/api/services', servicesRouter);
app.use('/api/orders', orderRouter);
app.use('/api/cron', cronRouter);
app.use('/api/deposits', depositRouter);

app.post('/api/auth/profile', verifyFirebaseToken, async (req, res) => {
  try { await ensureUserProfile(req.user.uid, req.user.email || '', { displayName: req.body?.displayName || req.user.name || '', photoURL: req.body?.photoURL || req.user.picture || '' }); const snap = await db.collection('users').doc(req.user.uid).get(); res.json({ ok: true, user: serializeData(snap.data() || {}) }); }
  catch (error) { console.error('[SERVER] auth profile:', error); res.status(500).json({ ok: false, error: 'Không thể khởi tạo hồ sơ.', code: error.code || 'PROFILE_ERROR' }); }
});

async function setUsernameProfile(req, res) {
  const uid = req.user.uid; const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username phải 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới' });
  const key = username.toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid); const usernameRef = db.collection('usernames').doc(key); const userSnap = await tx.get(userRef); const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists && String(usernameSnap.data()?.uid || '') !== uid) throw Object.assign(new Error('Username đã được sử dụng'), { code: 'USERNAME_TAKEN' });
      const oldUsername = String(userSnap.data()?.username || '').trim();
      if (oldUsername && oldUsername.toLowerCase() !== key) { const oldRef = db.collection('usernames').doc(oldUsername.toLowerCase()); const oldSnap = await tx.get(oldRef); if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) tx.delete(oldRef); }
      tx.set(usernameRef, { uid, username, email: req.user.email || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { uid, email: req.user.email || '', username, usernameLower: key, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    res.json({ ok: true, username });
  } catch (error) { if (error.code === 'USERNAME_TAKEN') return res.status(409).json({ error: error.message }); console.error('[SERVER] profile:', error); res.status(500).json({ error: 'Không thể lưu username' }); }
}
app.post('/api/account/profile', verifyFirebaseToken, setUsernameProfile);
app.post('/account/profile', verifyFirebaseToken, setUsernameProfile);

async function getAccountProfile(req, res) {
  try { const snap = await db.collection('users').doc(req.user.uid).get(); const user = snap.exists ? snap.data() : { uid: req.user.uid, email: req.user.email || '', balance: 0 }; res.json({ uid: req.user.uid, user: serializeData(user) }); }
  catch (error) { console.error('[SERVER] profile get:', error); res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' }); }
}
app.get('/api/account/profile', verifyFirebaseToken, getAccountProfile);
app.get('/account/profile', verifyFirebaseToken, getAccountProfile);

app.get('/api/balance-logs', verifyFirebaseToken, async (req, res) => {
  try { const snap = await db.collection('balance_logs').where('uid', '==', req.user.uid).limit(100).get(); const logs = snap.docs.map(serializeDoc).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); res.json({ logs }); }
  catch (error) { console.error('[SERVER] balance logs:', error); res.status(500).json({ error: 'Không thể lấy biến động số dư' }); }
});
app.get('/api/me', verifyFirebaseToken, async (req, res) => {
  try { const snap = await db.collection('users').doc(req.user.uid).get(); if (!snap.exists) return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' }); res.json({ uid: req.user.uid, user: serializeData(snap.data()) }); }
  catch (error) { console.error('[SERVER] me:', error); res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' }); }
});

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.status(401).json({ error: 'Invalid secret' });
    if (!configuredTelegram()) return res.status(503).json({ error: 'Telegram bot is not configured', code: 'TELEGRAM_NOT_CONFIGURED' });
    await handleTelegramUpdate(req.body || {}, db, admin);
    res.json({ ok: true });
  } catch (error) { console.error('[TELEGRAM] webhook:', error); res.status(200).json({ ok: false, error: 'Webhook processing failed' }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found', path: req.path, code: 'NOT_FOUND' }));
app.use((req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));

app.use((error, req, res, next) => {
  console.error('[SERVER] unhandled error:', error);
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body', code: 'INVALID_JSON', message: error.message });
  res.status(500).json({ error: 'Internal server error', code: error.code || 'INTERNAL_ERROR', message: process.env.NODE_ENV === 'production' ? 'Internal server error' : String(error.message || error) });
});

if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log(`[SERVER] TDMS1VN backend listening on port ${PORT}`);
    try { const owner = await ensureOwnerAdmin(db, admin); console.log(`[SERVER] Admin owner bootstrap ready: ${owner}`); }
    catch (error) { console.warn('[SERVER] Admin owner bootstrap skipped:', error.message); }
    startAdminBot(db, admin).catch(error => console.error('[TELEGRAM] startup:', error));

    const orderInterval = Number(process.env.ORDER_SYNC_INTERVAL_MS || 300000);
    if (Number.isFinite(orderInterval) && orderInterval >= 60000) setInterval(() => cronModule.runScheduledSync(db, admin).catch(error => console.error('[CRON] scheduled order sync:', error)), orderInterval).unref();
    const serviceInterval = Number(process.env.SERVICE_AUTO_SYNC_INTERVAL_MS || 900000);
    if (Number.isFinite(serviceInterval) && serviceInterval >= 60000) setInterval(() => cronModule.runScheduledServiceSync(db).catch(error => console.error('[CRON] scheduled service sync:', error)), serviceInterval).unref();
    setTimeout(() => cronModule.runScheduledServiceSync(db).catch(error => console.error('[CRON] initial service sync:', error)), 5000).unref();
  });
  const shutdown = signal => { console.log(`[SERVER] received ${signal}, shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', reason => console.error('[SERVER] unhandledRejection:', reason));
process.on('uncaughtException', error => { console.error('[SERVER] uncaughtException:', error); process.exit(1); });

module.exports = app;
