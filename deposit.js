'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { roundMoney } = require('./pricing');
const { authRequired } = require('./middleware/auth');

const DEFAULT_CARD_TYPES = ['Viettel', 'Vinaphone', 'Mobifone', 'Vietnamobile', 'Zing', 'Gate', 'Garena', 'Vcoin', 'Funtap'];
const DEFAULT_AMOUNTS = [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000];

function configuredCardTypes() {
  const raw = String(process.env.CARD_TYPES || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_CARD_TYPES).map(v => v.trim()).filter(Boolean));
}

function configuredAmounts() {
  const raw = String(process.env.CARD_DENOMINATIONS || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_AMOUNTS.map(String)).map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isSafeInteger(v) && v > 0));
}

function cardDiscountPercent(raw = process.env.CARD_DISCOUNT_PERCENT) {
  const value = Number(raw == null || raw === '' ? 30 : raw);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 30;
}

function cardCredit(faceValue, storedDiscount = null) {
  const discount = storedDiscount == null ? cardDiscountPercent() : cardDiscountPercent(storedDiscount);
  return Math.max(0, Math.round(Number(faceValue) * (1 - discount / 100)));
}

function bankCredit(amount) {
  return Math.max(0, Math.round(Number(amount)));
}

function requireUser(req, res, next) { return authRequired(req, res, next); }

function telegramToken() {
  return String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function telegramChatId() {
  return String(process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
}

function telegramClient() {
  const botToken = telegramToken();
  if (!botToken) throw new Error('Telegram bot token is not configured');
  return axios.create({ baseURL: `https://api.telegram.org/bot${botToken}`, timeout: 15000 });
}

async function telegram(method, payload) {
  const response = await telegramClient().post(`/${method}`, payload);
  if (!response.data?.ok) throw new Error(response.data?.description || `Telegram ${method} failed`);
  return response.data.result;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getProfile(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  return { email: String(data.email || ''), username: String(data.username || ''), name: String(data.name || data.displayName || '') };
}

function depositKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ Duyệt', callback_data: `deposit:approve:${id}` },
      { text: '❌ Thất bại', callback_data: `deposit:reject:${id}` }
    ]]
  };
}

function buildDepositMessage({ id, profile, type, amount, extra, creditedAmount }) {
  return [
    '<b>TDMS1VN — YÊU CẦU NẠP TIỀN</b>',
    `ID: <code>${esc(id)}</code>`,
    `Gmail: <code>${esc(profile.email || '—')}</code>`,
    `Username: <code>${esc(profile.username || '—')}</code>`,
    `Mệnh giá: <b>${Number(amount).toLocaleString('vi-VN')}đ</b>`,
    type === 'card' ? `Loại thẻ: <b>${esc(extra?.cardType || '—')}</b>` : 'Phương thức: <b>Chuyển khoản ngân hàng</b>',
    type === 'card' ? `Số Seri: <code>${esc(extra?.serial || '—')}</code>` : '',
    type === 'card' ? `Mã thẻ: <code>${esc(extra?.code || '—')}</code>` : '',
    `Thực nhận: <b>${Number(creditedAmount).toLocaleString('vi-VN')}đ</b>`,
    type === 'card' ? `Chiết khấu: <b>${cardDiscountPercent(extra?.discountPercent)}%</b>` : 'Tỷ lệ chuyển khoản: <b>100%</b>',
    '',
    '<i>Duyệt bằng nút bên dưới hoặc Admin Bot.</i>'
  ].filter(Boolean).join('\n');
}

async function createDepositAndNotify({ db, admin, uid, type, amount, extra = {} }) {
  const profile = await getProfile(db, uid);
  const depositRef = db.collection('deposits').doc(crypto.randomUUID());
  const faceValue = Math.round(Number(amount));
  if (!Number.isSafeInteger(faceValue) || faceValue <= 0) throw new Error('Số tiền nạp không hợp lệ');
  const discountPercent = type === 'card' ? cardDiscountPercent(extra.discountPercent) : 0;
  const creditedAmount = type === 'card' ? cardCredit(faceValue, discountPercent) : bankCredit(faceValue);

  const deposit = {
    id: depositRef.id,
    uid,
    type,
    amount: faceValue,
    creditedAmount,
    discountPercent,
    status: 'Chờ duyệt',
    email: profile.email,
    username: profile.username,
    name: profile.name,
    ...extra,
    adminNotified: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await depositRef.create(deposit);

  const text = buildDepositMessage({ id: depositRef.id, profile, type, amount: faceValue, extra, creditedAmount });
  let notified = false;
  let lastError = '';
  const chatId = telegramChatId();

  if (telegramToken() && chatId) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const message = await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: depositKeyboard(depositRef.id) });
        notified = true;
        await depositRef.update({ adminNotified: true, adminMessageId: message?.message_id ?? null, adminChatId: chatId, adminNotificationError: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        break;
      } catch (error) {
        lastError = String(error.message || error);
        console.error(`[TELEGRAM] Deposit notification attempt ${attempt}:`, lastError);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  } else {
    lastError = 'Telegram admin bot is not configured';
    console.warn('[TELEGRAM] Deposit created without Telegram notification:', lastError);
  }

  if (!notified) await depositRef.update({ adminNotified: false, adminNotificationError: lastError, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { id: depositRef.id, adminNotified: notified, creditedAmount };
}

async function grantDeposit(db, admin, depositId, decision, reviewer = {}) {
  const cleanId = String(depositId || '').trim();
  if (!cleanId) throw new Error('Deposit ID is required');
  if (!['approve', 'reject'].includes(decision)) throw new Error('Invalid deposit decision');

  const depositRef = db.collection('deposits').doc(cleanId);
  const result = await db.runTransaction(async tx => {
    const depSnap = await tx.get(depositRef);
    if (!depSnap.exists) throw Object.assign(new Error('Deposit not found'), { code: 'DEPOSIT_NOT_FOUND' });
    const dep = depSnap.data() || {};
    const status = String(dep.status || '').trim();
    const terminal = ['Thành công', 'Thất bại', 'Approved', 'Rejected', 'Completed'].includes(status);
    if (terminal) return { alreadyProcessed: true, status, amount: Number(dep.amount || 0), creditedAmount: Number(dep.creditedAmount || 0), uid: String(dep.uid || dep.userId || ''), newBalance: Number(dep.newBalance || 0) };

    const uid = String(dep.uid || dep.userId || '').trim();
    if (!uid) throw Object.assign(new Error('Deposit has no user UID'), { code: 'DEPOSIT_INVALID' });

    if (decision === 'reject') {
      tx.update(depositRef, {
        status: 'Thất bại',
        creditedAmount: 0,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: String(reviewer.uid || reviewer.id || 'telegram-admin'),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { alreadyProcessed: false, status: 'Thất bại', amount: Number(dep.amount || 0), creditedAmount: 0, uid };
    }

    const faceValue = Number(dep.amount);
    if (!Number.isFinite(faceValue) || faceValue <= 0) throw Object.assign(new Error('Deposit amount is invalid'), { code: 'DEPOSIT_INVALID' });
    const credit = dep.type === 'card' ? cardCredit(faceValue, dep.discountPercent) : bankCredit(faceValue);
    if (!Number.isSafeInteger(credit) || credit <= 0) throw Object.assign(new Error('Credit amount is invalid'), { code: 'DEPOSIT_INVALID' });

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw Object.assign(new Error('User account not found'), { code: 'USER_NOT_FOUND' });
    const currentBalance = Number(userSnap.data()?.balance || 0);
    if (!Number.isFinite(currentBalance) || currentBalance < 0) throw Object.assign(new Error('Current balance is invalid'), { code: 'INVALID_BALANCE' });
    const newBalance = roundMoney(currentBalance + credit);
    const logRef = db.collection('balance_logs').doc();

    tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(depositRef, {
      status: 'Thành công',
      creditedAmount: credit,
      oldBalance: currentBalance,
      newBalance,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: String(reviewer.uid || reviewer.id || 'telegram-admin'),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.create(logRef, {
      uid,
      amount: credit,
      type: 'credit',
      reason: dep.type === 'card' ? `Nạp thẻ - chiết khấu ${cardDiscountPercent(dep.discountPercent)}% - ${cleanId}` : `Nạp chuyển khoản - 100% - ${cleanId}`,
      oldBalance: currentBalance,
      newBalance,
      depositId: cleanId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { alreadyProcessed: false, status: 'Thành công', amount: faceValue, creditedAmount: credit, uid, oldBalance: currentBalance, newBalance };
  });

  console.log(`[DEPOSIT] ${result.alreadyProcessed ? 'Already processed' : 'Processed'} id=${cleanId} decision=${decision} status=${result.status}`);
  return result;
}

router.get('/', requireUser, async (req, res) => {
  try {
    const snap = await req.app.locals.db.collection('deposits').where('uid', '==', req.user.uid).limit(100).get();
    const items = snap.docs.map(doc => ({ id: doc.id, ...doc.data(), code: undefined })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ ok: true, deposits: items, items });
  } catch (error) {
    console.error('[DEPOSIT] list failed:', error);
    res.status(500).json({ error: 'Không thể lấy lịch sử nạp tiền' });
  }
});

router.get('/cards', requireUser, (req, res) => {
  const discountPercent = cardDiscountPercent();
  res.json({ cardTypes: Array.from(configuredCardTypes()), denominations: Array.from(configuredAmounts()).sort((a, b) => a - b), discountPercent });
});

router.get('/bank', requireUser, (req, res) => {
  res.json({ bankBin: process.env.BANK_BIN || '', accountNumber: process.env.BANK_ACCOUNT_NUMBER || '', accountName: process.env.BANK_ACCOUNT_NAME || '', qrTemplate: process.env.BANK_QR_TEMPLATE || 'compact2', bankCreditPercent: 100 });
});

router.post('/cards', requireUser, async (req, res) => {
  const { cardType, serial, code, amount } = req.body || {};
  const normalizedAmount = Number.parseInt(amount, 10);
  const type = String(cardType || '').trim();
  const serialClean = String(serial || '').trim();
  const codeClean = String(code || '').trim();
  if (!configuredCardTypes().has(type) || !configuredAmounts().has(normalizedAmount) || !serialClean || !codeClean) return res.status(400).json({ error: 'Loại thẻ hoặc mệnh giá không hợp lệ' });
  if (serialClean.length > 100 || codeClean.length > 100) return res.status(400).json({ error: 'Thông tin thẻ quá dài' });
  try {
    const discountPercent = cardDiscountPercent();
    const result = await createDepositAndNotify({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, type: 'card', amount: normalizedAmount, extra: { cardType: type, serial: serialClean, code: codeClean, discountPercent } });
    res.status(201).json({ ok: true, depositId: result.id, adminNotified: result.adminNotified, faceValue: normalizedAmount, creditedAmount: cardCredit(normalizedAmount, discountPercent), discountPercent });
  } catch (error) {
    console.error('[DEPOSIT] card create:', error);
    res.status(500).json({ error: 'Không thể gửi yêu cầu nạp thẻ', code: error.code || 'DEPOSIT_ERROR' });
  }
});

router.post('/bank', requireUser, async (req, res) => {
  const amount = Number.parseInt(req.body?.amount, 10);
  if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000) return res.status(400).json({ error: 'Số tiền chuyển khoản không hợp lệ' });
  try {
    const result = await createDepositAndNotify({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, type: 'bank', amount, extra: { paymentMethod: 'bank', bankCreditPercent: 100, note: String(req.body?.note || '').trim().slice(0, 200) } });
    res.status(201).json({ ok: true, depositId: result.id, adminNotified: result.adminNotified, amount, creditedAmount: amount, bankCreditPercent: 100 });
  } catch (error) {
    console.error('[DEPOSIT] bank create:', error);
    res.status(500).json({ error: 'Không thể gửi yêu cầu chuyển khoản', code: error.code || 'DEPOSIT_ERROR' });
  }
});

module.exports = router;
module.exports.grantDeposit = grantDeposit;
module.exports.createDepositAndNotify = createDepositAndNotify;
module.exports.buildDepositMessage = buildDepositMessage;
module.exports.depositKeyboard = depositKeyboard;
module.exports.cardCredit = cardCredit;
module.exports.bankCredit = bankCredit;
module.exports.cardDiscountPercent = cardDiscountPercent;
