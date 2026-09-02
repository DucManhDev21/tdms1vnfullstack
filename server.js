require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const servicesRouter = require('./services');
const orderRouter = require('./order');
const cronModule = require('./cron');
const depositRouter = require('./deposit');
const { startAdminBot } = require('./admin-bot');

const app = express();
const PORT = Number(process.env.PORT || 8080);

if (!admin.apps.length) {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch (error) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const auth = admin.auth();

app.locals.db = db;
app.locals.auth = auth;
app.locals.admin = admin;

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));

const DEFAULT_CORS_ORIGINS = [
  'https://tdms1vip.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const allowedCorsOrigins = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(v => v.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

for (const origin of DEFAULT_CORS_ORIGINS) allowedCorsOrigins.add(origin);

if (process.env.CORS_ORIGINS === '*') allowedCorsOrigins.add('*');

function isAllowedOrigin(origin) {
  return !origin || allowedCorsOrigins.has('*') || allowedCorsOrigins.has(origin);
}

// Explicit CORS headers are set before every route so even API errors keep the
// Access-Control-Allow-Origin header and the browser can expose the response.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    else if (allowedCorsOrigins.has('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Cron-Secret, X-Telegram-Bot-Api-Secret-Token, X-Deposit-Signature');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'CORS origin denied' });
    return res.status(204).end();
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Cron-Secret', 'X-Telegram-Bot-Api-Secret-Token', 'X-Deposit-Signature'],
  credentials: false,
  maxAge: 86400
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

app.use('/api', publicLimiter);
app.use('/api/orders', mutationLimiter);
app.use('/api/deposits', mutationLimiter);

async function verifyToken(req, res, next) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = header.slice(7).trim();
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });
  try {
    req.user = await auth.verifyIdToken(token, true);
    return next();
  } catch (error) {
    console.error('verify token:', error.message);
    return res.status(401).json({ error: 'Invalid or expired authorization token' });
  }
}

app.locals.verifyToken = verifyToken;

app.get('/health', (req, res) => {
  res.set('Cache-Control','no-store');
  res.json({ ok: true, service: 'TDMS1VN', version: '7.2.0', time: new Date().toISOString() });
});

app.get('/api/health', (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({ ok:true, service:'TDMS1VN API', version:'7.0.0', time:new Date().toISOString() });
});

app.get('/api/ping', (req,res) => res.json({ ok:true, time:new Date().toISOString() }));

app.get('/api/system/status', async (req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.set('Cache-Control','no-store');
    res.json({
      ok: true,
      api: 'online',
      firestore: 'online',
      adminTelegramBot: Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim()),
      pricing: { providerRateMode: process.env.PROVIDER_RATE_MODE || 'USD_PER_1000', displayUnit: 'VND/1' },
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error('system status:', error);
    res.status(503).json({ ok:false, api:'online', firestore:'error', error:'Firestore unavailable' });
  }
});

// API root must be a real API response. The old server tried to serve
// /public/index.html here, but the Railway backend repository does not contain
// a public/ directory because the SPA is deployed separately on Vercel.
app.get('/api', (req, res) => {
  res.json({
    ok: true,
    service: 'TDMS1VN API',
    version: '7.2.0',
    frontend: 'https://tdms1vip.vercel.app',
    endpoints: ['/health', '/api/config/public', '/api/public/stats', '/api/services', '/api/orders', '/api/deposits', '/api/balance-logs', '/api/me', '/api/admin/session']
  });
});

app.get('/api/admin/session', verifyToken, async (req, res) => {
  try {
    const token = req.user || {};
    const isAdmin = token.admin === true || token.role === 'admin';
    if (!isAdmin) return res.status(403).json({ ok:false, error:'Bạn không có quyền truy cập khu vực Admin.' });
    const userRecord = await auth.getUser(token.uid);
    if (!userRecord.emailVerified) return res.status(403).json({ ok:false, error:'Gmail Admin chưa được xác minh.' });
    if (userRecord.disabled) return res.status(403).json({ ok:false, error:'Tài khoản Admin đã bị vô hiệu hóa.' });
    res.set('Cache-Control','no-store');
    res.json({ ok:true, admin:true, uid:userRecord.uid, email:userRecord.email || '', claims:{admin:true, role:token.role || 'admin'} });
  } catch (error) {
    console.error('admin session:', error);
    res.status(403).json({ ok:false, error:'Không thể xác thực phiên Admin.' });
  }
});

app.get('/api/public/stats', async (req, res) => {
  try {
    const [usersSnap, ordersSnap, completedSnap] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('orders').count().get(),
      db.collection('orders').where('status', '==', 'Completed').count().get()
    ]);
    res.json({ users: usersSnap.data().count, orders: ordersSnap.data().count, completed: completedSnap.data().count });
  } catch (error) {
    console.error('public stats:', error);
    res.status(500).json({ error: 'Không lấy được thống kê' });
  }
});

app.get('/api/config/public', (req, res) => {
  res.json({
    telegram: process.env.ADMIN_TELEGRAM_HANDLE || '@ducmanh2109',
    email: process.env.ADMIN_EMAIL || 'tranvanmanhbg123bg@gmail.com',
    bank: {
      bankBin: process.env.BANK_BIN || '',
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
      accountName: process.env.BANK_ACCOUNT_NAME || '',
      qrTemplate: process.env.BANK_QR_TEMPLATE || 'compact2'
    },
    currency: process.env.CURRENCY || 'VND',
    cardTypes: String(process.env.CARD_TYPES || 'Viettel,Vinaphone,Mobifone,Vietnamobile,Zing,Gate,Garena').split(',').map(v => v.trim()).filter(Boolean),
    cardDenominations: String(process.env.CARD_DENOMINATIONS || '10000,20000,30000,50000,100000,200000,300000,500000,1000000').split(',').map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isInteger(v) && v > 0),
    cardDiscountPercent: 30,
    bankCreditPercent: 100,
    pricing: { providerRateMode: process.env.PROVIDER_RATE_MODE || 'USD_PER_1000', displayUnit: 'VND/1' }, adminTelegramBot: Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim())
  });
});

app.use('/api/services', servicesRouter);
app.use('/api/orders', orderRouter);
app.use('/api/cron', cronModule);
app.use('/api/deposits', depositRouter);

app.post('/api/account/profile', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username phải 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới' });
  }
  const key = username.toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid);
      const usernameRef = db.collection('usernames').doc(key);
      const userSnap = await tx.get(userRef);
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists && String(usernameSnap.data()?.uid || '') !== uid) {
        throw Object.assign(new Error('Username đã được sử dụng'), { code: 'USERNAME_TAKEN' });
      }
      const oldUsername = String(userSnap.data()?.username || '').trim();
      if (oldUsername && oldUsername.toLowerCase() !== key) {
        const oldRef = db.collection('usernames').doc(oldUsername.toLowerCase());
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) tx.delete(oldRef);
      }
      tx.set(usernameRef, { uid, username, email: req.user.email || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { uid, email: req.user.email || '', username, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    res.json({ ok: true, username });
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN') return res.status(409).json({ error: error.message });
    console.error('profile:', error);
    res.status(500).json({ error: 'Không thể lưu username' });
  }
});


// Compatibility aliases: some older frontend deployments requested /account/profile
// directly. Keep them available while the canonical API remains /api/account/profile.
app.post('/account/profile', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username phải 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới' });
  }
  const key = username.toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid);
      const usernameRef = db.collection('usernames').doc(key);
      const userSnap = await tx.get(userRef);
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists && String(usernameSnap.data()?.uid || '') !== uid) {
        throw Object.assign(new Error('Username đã được sử dụng'), { code: 'USERNAME_TAKEN' });
      }
      const oldUsername = String(userSnap.data()?.username || '').trim();
      if (oldUsername && oldUsername.toLowerCase() !== key) {
        const oldRef = db.collection('usernames').doc(oldUsername.toLowerCase());
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) tx.delete(oldRef);
      }
      tx.set(usernameRef, { uid, username, email: req.user.email || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { uid, email: req.user.email || '', username, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    res.json({ ok: true, username });
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN') return res.status(409).json({ error: error.message });
    console.error('profile alias:', error);
    res.status(500).json({ error: 'Không thể lưu username' });
  }
});

app.get('/account/profile', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    const user = snap.exists ? snap.data() : { uid: req.user.uid, email: req.user.email || '', balance: 0 };
    res.json({ uid: req.user.uid, user });
  } catch (error) {
    console.error('profile alias get:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

app.get('/api/account/profile', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    const user = snap.exists ? snap.data() : { uid: req.user.uid, email: req.user.email || '', balance: 0 };
    res.json({ uid: req.user.uid, user });
  } catch (error) {
    console.error('profile get:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

app.get('/api/balance-logs', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('balance_logs').where('uid', '==', req.user.uid).limit(100).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ logs });
  } catch (error) {
    console.error('balance logs:', error);
    res.status(500).json({ error: 'Không thể lấy biến động số dư' });
  }
});

app.get('/api/me', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    res.json({ uid: req.user.uid, user: snap.data() });
  } catch (error) {
    console.error('me:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

// This backend is API-only. Do NOT call express.static() or sendFile() here.
// The frontend is hosted independently by Vercel.
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found', path: req.path }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TDMS1VN API server listening on ${PORT}`);
    startAdminBot(db, admin).catch(error => console.error('Admin Telegram bot startup:', error));
    const interval = Number(process.env.ORDER_SYNC_INTERVAL_MS || 300000);
    if (Number.isFinite(interval) && interval >= 60000) {
      setInterval(() => {
        cronModule.runScheduledSync(db, admin).catch(error => console.error('scheduled order sync:', error));
      }, interval).unref();
    }
  });
}


module.exports = app;
