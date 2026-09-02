const axios = require('axios');

let started = false;
let offset = 0;

function token() {
  const value = String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim();
  if (!value) throw new Error('ADMIN_TELEGRAM_BOT_TOKEN is not configured');
  return value;
}

function client() {
  return axios.create({
    baseURL: `https://api.telegram.org/bot${token()}`,
    timeout: 35000
  });
}

function adminChatId() {
  return String(process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim();
}

function isAuthorized(update) {
  const chatId = String(update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || '');
  const senderId = String(update?.message?.from?.id || update?.callback_query?.from?.id || '');
  const configuredChat = adminChatId();
  const configuredUsers = String(process.env.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!configuredChat || chatId !== configuredChat) return false;
  return configuredUsers.length === 0 || configuredUsers.includes(senderId);
}

async function telegram(method, payload) {
  const response = await client().post(`/${method}`, payload);
  if (!response.data?.ok) throw new Error(response.data?.description || `Telegram ${method} failed`);
  return response.data.result;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value) {
  return `${Number(value).toLocaleString('vi-VN')}đ`;
}

function partsFromCommand(text) {
  return String(text || '').trim().split(/\s+/);
}

function splitPipeArguments(text) {
  return String(text || '').split('|').map(x => x.trim());
}

function parsePay(text) {
  const p = partsFromCommand(text);
  if (p.length !== 3) throw new Error('Cú pháp: /pay username số_tiền');
  const username = p[1].replace(/^@/, '').trim();
  const amount = Number(p[2].replace(/[,._\s]/g, ''));
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username không hợp lệ.');
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) throw new Error('Số tiền phải là số nguyên dương, tối đa 1.000.000.000đ.');
  return { username, amount };
}

function parseAddPopup(text) {
  const raw = String(text || '').trim();
  const args = splitPipeArguments(raw);
  if (args.length !== 3) throw new Error('Cú pháp: /addpopup ID | Tiêu đề | Nội dung');
  let id, title, content;
  if (/^[A-Za-z0-9_-]{2,64}$/.test(args[0])) {
    [id, title, content] = args;
  } else if (/^[A-Za-z0-9_-]{2,64}$/.test(args[2])) {
    [title, content, id] = args;
  } else {
    throw new Error('ID phải 2-64 ký tự, chỉ gồm chữ, số, _ hoặc -.');
  }
  if (!title || !content) throw new Error('Tiêu đề và nội dung không được để trống.');
  if (title.length > 200) throw new Error('Tiêu đề tối đa 200 ký tự.');
  if (content.length > 5000) throw new Error('Nội dung tối đa 5000 ký tự.');
  return { id, title, content };
}

function parseDeletePopup(text) {
  const p = partsFromCommand(text);
  if (p.length !== 2) throw new Error('Cú pháp: /deletepopup ID');
  const id = p[1].trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw new Error('ID popup không hợp lệ.');
  return id;
}

async function findUserByUsername(db, username) {
  const key = username.toLowerCase();
  const usernameSnap = await db.collection('usernames').doc(key).get();
  if (usernameSnap.exists && usernameSnap.data()?.uid) {
    const uid = String(usernameSnap.data().uid);
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) return { uid, ref: userSnap.ref, data: userSnap.data() || {} };
  }
  const query = await db.collection('users').where('username', '==', username).limit(2).get();
  if (query.size === 1) return { uid: query.docs[0].id, ref: query.docs[0].ref, data: query.docs[0].data() || {} };
  if (query.size > 1) throw new Error('Có nhiều tài khoản trùng username, hãy kiểm tra collection usernames.');
  const lowerQuery = await db.collection('users').where('usernameLower', '==', key).limit(2).get();
  if (lowerQuery.size === 1) return { uid: lowerQuery.docs[0].id, ref: lowerQuery.docs[0].ref, data: lowerQuery.docs[0].data() || {} };
  throw new Error(`Không tìm thấy username @${username}.`);
}

async function pay(db, admin, username, amount) {
  const user = await findUserByUsername(db, username);
  return db.runTransaction(async tx => {
    const snap = await tx.get(user.ref);
    if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
    const data = snap.data() || {};
    const oldBalance = Number(data.balance || 0);
    if (!Number.isSafeInteger(oldBalance) || oldBalance < 0) throw new Error('Số dư hiện tại không hợp lệ.');
    const newBalance = oldBalance + amount;
    if (!Number.isSafeInteger(newBalance)) throw new Error('Số dư vượt giới hạn an toàn.');
    const pendingSnap = await tx.get(db.collection('deposits').where('uid', '==', user.uid).where('status', '==', 'Chờ duyệt').limit(20));
    const matching = pendingSnap.docs.filter(doc => Number(doc.data()?.creditedAmount || 0) === amount);
    const matchedDeposit = matching.length === 1 ? matching[0] : null;
    const logRef = db.collection('balance_logs').doc();
    tx.update(user.ref, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(logRef, {
      uid: user.uid,
      amount,
      type: 'credit',
      reason: matchedDeposit ? `Admin Telegram /pay — duyệt ${matchedDeposit.id}` : 'Admin Telegram /pay',
      oldBalance,
      newBalance,
      adminAction: 'telegram_pay',
      adminUsername: username,
      depositId: matchedDeposit ? matchedDeposit.id : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (matchedDeposit) {
      tx.update(matchedDeposit.ref, {
        status: 'Thành công',
        creditedAmount: amount,
        oldBalance,
        newBalance,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return { uid: user.uid, email: String(data.email || ''), username: String(data.username || username), oldBalance, newBalance, amount, matchedDepositId: matchedDeposit?.id || '' };
  });
}

async function addPopup(db, admin, { id, title, content }) {
  const ref = db.collection('popups').doc(id);
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) throw new Error(`Popup ID ${id} đã tồn tại. Dùng ID khác.`);
    tx.create(ref, {
      id,
      title,
      content,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
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

async function help(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: '<b>TDMS1VN — ADMIN BOT</b>\n\n/pay username số_tiền\n/addpopup ID | Tiêu đề | Nội dung\n/deletepopup ID\n/help\n\nVí dụ:\n/pay hung123 50000\n/addpopup TB1 | Thông báo | Nội dung thông báo\n/deletepopup TB1',
    parse_mode: 'HTML'
  });
}

async function handleMessage(message, db, admin) {
  const chatId = String(message?.chat?.id || '');
  const text = String(message?.text || '').trim();
  if (!text.startsWith('/')) return;
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (command === '/start' || command === '/help') return help(chatId);
  if (command === '/pay') {
    const { username, amount } = parsePay(text);
    const result = await pay(db, admin, username, amount);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>CỘNG TIỀN THÀNH CÔNG</b>\nUsername: <code>@${esc(result.username)}</code>\nCộng: <b>${money(result.amount)}</b>\nSố dư cũ: ${money(result.oldBalance)}\nSố dư mới: <b>${money(result.newBalance)}</b>${result.matchedDepositId ? `\nDeposit: <code>${esc(result.matchedDepositId)}</code> → Thành công` : ''}`, parse_mode: 'HTML' });
  }
  if (command === '/addpopup') {
    const data = parseAddPopup(text);
    await addPopup(db, admin, data);
    return telegram('sendMessage', { chat_id: chatId, text: `✅ <b>ĐÃ THÊM POPUP</b>\nID: <code>${esc(data.id)}</code>\nTiêu đề: <b>${esc(data.title)}</b>`, parse_mode: 'HTML' });
  }
  if (command === '/deletepopup') {
    const id = parseDeletePopup(text);
    await deletePopup(db, id);
    return telegram('sendMessage', { chat_id: chatId, text: `🗑️ <b>ĐÃ XÓA POPUP</b>\nID: <code>${esc(id)}</code>`, parse_mode: 'HTML' });
  }
  await help(chatId);
}

async function handleUpdate(update, db, admin) {
  if (!update?.message) return;
  if (!isAuthorized(update)) {
    const chatId = String(update.message.chat?.id || '');
    if (chatId) await telegram('sendMessage', { chat_id: chatId, text: '⛔ Bạn không có quyền sử dụng bot admin.' }).catch(() => {});
    return;
  }
  try {
    await handleMessage(update.message, db, admin);
  } catch (error) {
    console.error('Admin bot command:', error);
    await telegram('sendMessage', { chat_id: String(update.message.chat.id), text: `❌ ${error.message || 'Có lỗi xảy ra.'}` }).catch(() => {});
  }
}

async function startAdminBot(db, admin) {
  if (started) return;
  if (!String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim()) {
    console.log('Admin Telegram bot disabled: ADMIN_TELEGRAM_BOT_TOKEN is not configured');
    return;
  }
  if (!adminChatId()) {
    console.error('Admin Telegram bot disabled: ADMIN_TELEGRAM_CHAT_ID is not configured');
    return;
  }
  started = true;
  console.log('Admin Telegram bot: LONG POLLING');
  try {
    await telegram('deleteWebhook', { drop_pending_updates: true });
    const loop = async () => {
      while (started) {
        try {
          const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
          for (const update of updates || []) {
            offset = Number(update.update_id) + 1;
            await handleUpdate(update, db, admin);
          }
        } catch (error) {
          console.error('Admin Telegram polling:', error.response?.data || error.message);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    };
    loop().catch(error => console.error('Admin Telegram loop stopped:', error));
  } catch (error) {
    started = false;
    console.error('Admin Telegram startup failed:', error.response?.data || error.message);
  }
}

module.exports = { startAdminBot, parsePay, parseAddPopup, parseDeletePopup };
