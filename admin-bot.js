'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');
const { grantDeposit } = require('./deposit');
const { addAdmin, deleteAdmin, listAdmins, validateEmail, ownerEmail } = require('./admins');

let started = false;
let offset = 0;

function token() {
  const value = String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!value) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return value;
}

function client() {
  return axios.create({ baseURL: `https://api.telegram.org/bot${token()}`, timeout: 35000 });
}

function configuredUsers() {
  return String(process.env.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
}

function configuredChat() {
  return String(process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
}

function updateActor(update) {
  return update?.callback_query || update?.message || update?.edited_message || {};
}

function isAuthorized(update) {
  const actor = updateActor(update);
  const chatId = String(actor?.message?.chat?.id || actor?.chat?.id || '');
  const senderId = String(actor?.from?.id || '');
  const users = configuredUsers();
  const chat = configuredChat();
  if (users.length && !users.includes(senderId)) return false;
  if (chat && chatId !== chat) return false;
  return users.length > 0 || Boolean(chat);
}

async function telegram(method, payload) {
  const response = await client().post(`/${method}`, payload);
  if (!response.data?.ok) throw new Error(response.data?.description || `Telegram ${method} failed`);
  return response.data.result;
}

function esc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(v) { return `${Number(v || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 })}đ`; }

function parsePay(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 3) throw new Error('Cú pháp: /pay username số_tiền');
  const username = p[1].replace(/^@/, '').trim();
  const amount = Number(p[2].replace(/[.,_\s]/g, ''));
  if (!username || username.length > 64) throw new Error('Username không hợp lệ.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new Error('Số tiền phải lớn hơn 0 và tối đa 1.000.000.000đ.');
  return { username, amount: Math.round(amount * 100) / 100 };
}

function parseTake(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 3) throw new Error('Cú pháp: /take username số_tiền');
  const username = p[1].replace(/^@/, '').trim();
  const amount = Number(p[2].replace(/[.,_\s]/g, ''));
  if (!username || username.length > 64) throw new Error('Username không hợp lệ.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new Error('Số tiền phải lớn hơn 0 và tối đa 1.000.000.000đ.');
  return { username, amount: Math.round(amount * 100) / 100 };
}

function parseAdminEmail(text, command) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 2) throw new Error(`Cú pháp: ${command} email@gmail.com`);
  return validateEmail(p[1]);
}

function validPopupId(id) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || '').trim()); }

function parseAddPopup(text) {
  const body = String(text || '').trim().replace(/^\/addpopup(?:@\w+)?\s*/i, '').trim();
  const args = body.split('|').map(x => x.trim());
  if (args.length !== 3) throw new Error('Cú pháp: /addpopup ID | Tiêu đề | Nội dung');
  let id, title, content;
  if (validPopupId(args[0])) [id, title, content] = args;
  else if (validPopupId(args[2])) [title, content, id] = args;
  else throw new Error('ID popup không hợp lệ.');
  if (!title || !content) throw new Error('Tiêu đề và nội dung không được để trống.');
  if (title.length > 200 || content.length > 5000) throw new Error('Tiêu đề tối đa 200 và nội dung tối đa 5000 ký tự.');
  return { id, title, content };
}

function parseDeletePopup(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 2 || !validPopupId(p[1])) throw new Error('Cú pháp: /deletepopup ID');
  return p[1];
}

async function findUserByUsername(db, username) {
  const clean = String(username || '').replace(/^@/, '').trim();
  const key = clean.toLowerCase();
  const mapSnap = await db.collection('usernames').doc(key).get();
  if (mapSnap.exists && mapSnap.data()?.uid) {
    const uid = String(mapSnap.data().uid);
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (snap.exists) return { uid, ref, data: snap.data() || {} };
  }
  const exact = await db.collection('users').where('username', '==', clean).limit(2).get();
  if (exact.size === 1) return { uid: exact.docs[0].id, ref: exact.docs[0].ref, data: exact.docs[0].data() || {} };
  const lower = await db.collection('users').where('usernameLower', '==', key).limit(2).get();
  if (lower.size === 1) return { uid: lower.docs[0].id, ref: lower.docs[0].ref, data: lower.docs[0].data() || {} };
  throw new Error(`Không tìm thấy username @${clean}.`);
}

async function pay(db, admin, username, amount) {
  const user = await findUserByUsername(db, username);
  return db.runTransaction(async tx => {
    const snap = await tx.get(user.ref);
    if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
    const data = snap.data() || {};
    const oldBalance = Number(data.balance || 0);
    if (!Number.isFinite(oldBalance) || oldBalance < 0) throw new Error('Số dư hiện tại không hợp lệ.');
    const newBalance = Math.round((oldBalance + amount) * 100) / 100;
    const logRef = db.collection('balance_logs').doc(crypto.randomUUID());
    tx.update(user.ref, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(logRef, { uid: user.uid, amount, type: 'credit', reason: 'Admin Telegram /pay', oldBalance, newBalance, adminAction: 'telegram_pay', adminUsername: username, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { uid: user.uid, email: String(data.email || ''), username: String(data.username || username), oldBalance, newBalance, amount };
  });
}

async function take(db, admin, username, amount) {
  const user = await findUserByUsername(db, username);
  return db.runTransaction(async tx => {
    const snap = await tx.get(user.ref);
    if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
    const data = snap.data() || {};
    const oldBalance = Number(data.balance || 0);
    if (!Number.isFinite(oldBalance) || oldBalance < 0) throw new Error('Số dư hiện tại không hợp lệ.');
    if (oldBalance < amount) throw new Error(`Số dư @${username} không đủ. Hiện có ${money(oldBalance)}.`);
    const newBalance = Math.round((oldBalance - amount) * 100) / 100;
    const logRef = db.collection('balance_logs').doc(crypto.randomUUID());
    tx.update(user.ref, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(logRef, { uid: user.uid, amount: -amount, type: 'debit', reason: 'Admin Telegram /take', oldBalance, newBalance, adminAction: 'telegram_take', adminUsername: username, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { uid: user.uid, email: String(data.email || ''), username: String(data.username || username), oldBalance, newBalance, amount };
  });
}

async function addPopup(db, admin, data) {
  const ref = db.collection('popups').doc(data.id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new Error(`Popup ID ${data.id} đã tồn tại.`);
    tx.create(ref, { ...data, active: true, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
}

async function deletePopup(db, id) {
  const ref = db.collection('popups').doc(id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Không tìm thấy popup ${id}.`);
    tx.delete(ref);
  });
}

async function sendAdminList(chatId, db) {
  const admins = await listAdmins(db);
  const owner = ownerEmail();
  const lines = admins.map((item, index) => `${index + 1}. <code>${esc(item.email)}</code>${String(item.email).toLowerCase() === owner ? ' 👑 <b>OWNER</b>' : ''}`);
  return telegram('sendMessage', { chat_id: chatId, text: `<b>👑 DANH SÁCH ADMIN (${admins.length})</b>\n\n${lines.join('\n') || 'Chưa có Admin nào.'}`, parse_mode: 'HTML' });
}

async function sendHelp(chatId) {
  return telegram('sendMessage', { chat_id: chatId, text: '<b>TDMS1VN ADMIN BOT</b>\n\n/pay username số_tiền\n/take username số_tiền\n/syncorders\n/syncservices\n/stats\n/addpopup ID | Tiêu đề | Nội dung\n/deletepopup ID\n/addadmin email@gmail.com\n/deleteadmin email@gmail.com\n/listadmin\n/help', parse_mode: 'HTML' });
}

async function handleMessage(message, db, admin) {
  const chatId = String(message?.chat?.id || '');
  const text = String(message?.text || '').trim();
  if (!text.startsWith('/')) return;
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (command === '/start' || command === '/help') return sendHelp(chatId);
  if (command === '/listadmin') return sendAdminList(chatId, db);
  if (command === '/addadmin') {
    const email = parseAdminEmail(text, '/addadmin');
    const added = await addAdmin(db, admin, email, { source: 'telegram', telegramUserId: String(message?.from?.id || ''), telegramUsername: String(message?.from?.username || '') });
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>ĐÃ THÊM ADMIN</b>\n\n📧 <code>${esc(added.email)}</code>`, parse_mode: 'HTML' });
  }
  if (command === '/deleteadmin') {
    const email = parseAdminEmail(text, '/deleteadmin');
    const deleted = await deleteAdmin(db, admin, email, { source: 'telegram', email: String(message?.from?.username || '') });
    return telegram('sendMessage', { chat_id: chatId, text: `🗑️ <b>ĐÃ XÓA ADMIN</b>\n\n📧 <code>${esc(deleted)}</code>`, parse_mode: 'HTML' });
  }
  if (command === '/pay') {
    const { username, amount } = parsePay(text);
    const r = await pay(db, admin, username, amount);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>CỘNG TIỀN THÀNH CÔNG</b>\n\n👤 @${esc(r.username)}\n📧 <code>${esc(r.email || '—')}</code>\n💰 Cộng: <b>${money(r.amount)}</b>\n💳 Số dư mới: <b>${money(r.newBalance)}</b>`, parse_mode: 'HTML' });
  }
  if (command === '/take') {
    const { username, amount } = parseTake(text);
    const r = await take(db, admin, username, amount);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>TRỪ TIỀN THÀNH CÔNG</b>\n\n👤 @${esc(r.username)}\n💸 Trừ: <b>${money(r.amount)}</b>\n💳 Số dư mới: <b>${money(r.newBalance)}</b>`, parse_mode: 'HTML' });
  }
  if (command === '/syncorders') {
    const result = await syncOrders({ db, admin, limit: 100 });
    return telegram('sendMessage', { chat_id: chatId, text: `🔄 <b>ĐỒNG BỘ ĐƠN</b>\n\nKiểm tra: <b>${result.checked}</b>\nCập nhật: <b>${result.updated}</b>\nLỗi Provider: <b>${result.failed}</b>\nHoàn tiền: <b>${money(result.refunded)}</b>`, parse_mode: 'HTML' });
  }
  if (command === '/syncservices') {
    const services = await syncServices(db, true);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>ĐỒNG BỘ SERVICE</b>\n\nSố service: <b>${services.length}</b>\nMarkup: <b>${esc(process.env.SERVICE_MARKUP_PERCENT || 0)}%</b>`, parse_mode: 'HTML' });
  }
  if (command === '/stats') {
    const [users, orders, pending, completed, deposits] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('orders').count().get(),
      db.collection('orders').where('status', 'in', ['Pending', 'In progress', 'Partial']).count().get(),
      db.collection('orders').where('status', '==', 'Completed').count().get(),
      db.collection('deposits').count().get()
    ]);
    return telegram('sendMessage', { chat_id: chatId, text: `📊 <b>TDMS1VN</b>\n\n👤 Users: <b>${users.data().count}</b>\n📦 Orders: <b>${orders.data().count}</b>\n⏳ Đang chạy: <b>${pending.data().count}</b>\n✅ Completed: <b>${completed.data().count}</b>\n💰 Deposits: <b>${deposits.data().count}</b>`, parse_mode: 'HTML' });
  }
  if (command === '/addpopup') {
    const data = parseAddPopup(text);
    await addPopup(db, admin, data);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ Đã thêm Popup <code>${esc(data.id)}</code>.`, parse_mode: 'HTML' });
  }
  if (command === '/deletepopup') {
    const id = parseDeletePopup(text);
    await deletePopup(db, id);
    return telegram('sendMessage', { chat_id: chatId, text: `🗑️ Đã xóa Popup <code>${esc(id)}</code>.`, parse_mode: 'HTML' });
  }
  return sendHelp(chatId);
}

async function handleCallback(callback, db, admin) {
  const chatId = String(callback?.message?.chat?.id || '');
  const data = String(callback?.data || '');
  const match = data.match(/^deposit:(approve|reject):([A-Za-z0-9_-]+)$/);
  if (!match) return telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Callback không hợp lệ.', show_alert: true });
  try {
    const decision = match[1];
    const result = await grantDeposit(db, admin, match[2], decision, { id: String(callback?.from?.id || ''), uid: String(callback?.from?.id || '') });
    const label = result.alreadyProcessed ? `Yêu cầu đã ở trạng thái ${result.status}.` : decision === 'approve' ? `Đã duyệt +${money(result.creditedAmount)}.` : 'Đã từ chối yêu cầu nạp tiền.';
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: label, show_alert: result.alreadyProcessed });
    const original = String(callback?.message?.text || '');
    const outcomeText = result.status === 'Thành công' ? '✅ ĐÃ DUYỆT' : '❌ ĐÃ TỪ CHỐI';
    await telegram('editMessageText', { chat_id: chatId, message_id: callback.message.message_id, text: `${original}\n\n<b>KẾT QUẢ:</b> ${outcomeText} — ${money(result.creditedAmount || result.amount || 0)}`, parse_mode: 'HTML' }).catch(error => console.error('[TELEGRAM] edit deposit message:', error.message));
  } catch (error) {
    console.error('[TELEGRAM] deposit callback:', error);
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: String(error.message || 'Không thể xử lý yêu cầu.'), show_alert: true }).catch(() => {});
  }
}

async function handleUpdate(update, db, admin) {
  const actor = update?.callback_query || update?.message;
  if (!actor) return;
  const chatId = String(actor?.message?.chat?.id || actor?.chat?.id || '');
  if (!isAuthorized(update)) {
    if (chatId && update.message) await telegram('sendMessage', { chat_id: chatId, text: '⛔ Bạn không có quyền sử dụng bot admin.' }).catch(() => {});
    if (update.callback_query) await telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Bạn không có quyền thao tác.', show_alert: true }).catch(() => {});
    return;
  }
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, db, admin);
    if (update.message) await handleMessage(update.message, db, admin);
  } catch (error) {
    console.error('[TELEGRAM] command:', error);
    if (chatId) await telegram('sendMessage', { chat_id: chatId, text: `❌ ${String(error.message || 'Có lỗi xảy ra.')}` }).catch(() => {});
  }
}

async function startAdminBot(db, admin) {
  if (started) return;
  if (!String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim()) {
    console.warn('[TELEGRAM] Admin bot disabled: TELEGRAM_BOT_TOKEN/ADMIN_TELEGRAM_BOT_TOKEN is not configured');
    return;
  }
  if (!configuredUsers().length && !configuredChat()) {
    console.warn('[TELEGRAM] Admin bot disabled: configure ADMIN_TELEGRAM_USER_IDS or TELEGRAM_ADMIN_CHAT_ID');
    return;
  }
  started = true;
  try {
    const me = await telegram('getMe', {});
    console.log(`[TELEGRAM] Admin bot connected: @${me.username || me.first_name || 'unknown'}`);
    await telegram('deleteWebhook', { drop_pending_updates: true });
    offset = 0;
    while (started) {
      try {
        const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates || []) {
          offset = Number(update.update_id) + 1;
          await handleUpdate(update, db, admin);
        }
      } catch (error) {
        const telegramError = error.response?.data || {};
        console.error('[TELEGRAM] polling:', telegramError.description || error.message);
        if (Number(telegramError.error_code) === 409) {
          console.error('[TELEGRAM] polling stopped: token is already used by another process');
          started = false;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  } catch (error) {
    started = false;
    console.error('[TELEGRAM] startup failed:', error.response?.data || error.message);
  }
}

module.exports = { startAdminBot, handleUpdate, handleCallback, parsePay, parseTake, parseAddPopup, parseDeletePopup, isAuthorized };
