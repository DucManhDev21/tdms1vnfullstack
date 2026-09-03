const axios = require('axios');

let started = false;
let offset = 0;

function token() {
  const value = String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim();
  if (!value) throw new Error('ADMIN_TELEGRAM_BOT_TOKEN chưa được cấu hình');
  return value;
}
function client() {
  return axios.create({ baseURL: `https://api.telegram.org/bot${token()}`, timeout: 35000 });
}
function configuredUsers() {
  return String(process.env.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
}
function configuredChat() { return String(process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim(); }
function isAuthorized(update) {
  const message = update?.message;
  const chatId = String(message?.chat?.id || '');
  const senderId = String(message?.from?.id || '');
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
function esc(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(v) { return `${Number(v).toLocaleString('vi-VN',{maximumFractionDigits:2})}đ`; }
function parsePay(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 3) throw new Error('Cú pháp: /pay username số_tiền');
  const username = p[1].replace(/^@/,'').trim();
  const amount = Number(p[2].replace(/[.,_\s]/g,''));
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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}
function parseAdminEmailCommand(text, command) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 2 || !validEmail(p[1])) {
    throw new Error(`Cú pháp: ${command} gmail@example.com`);
  }
  return normalizeEmail(p[1]);
}
async function addAdmin(admin, email) {
  const user = await admin.auth().getUserByEmail(email);
  if (user.disabled) throw new Error('Tài khoản Firebase này đang bị vô hiệu hóa.');
  const claims = { ...(user.customClaims || {}), admin: true, role: 'admin' };
  await admin.auth().setCustomUserClaims(user.uid, claims);
  return { uid: user.uid, email: user.email || email, displayName: user.displayName || '', disabled: !!user.disabled };
}
async function listAdmins(admin) {
  const items = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      const claims = user.customClaims || {};
      if (claims.admin === true || claims.role === 'admin') {
        items.push({
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          disabled: !!user.disabled,
          emailVerified: !!user.emailVerified
        });
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return items.sort((a, b) => a.email.localeCompare(b.email));
}
async function deleteAdmin(admin, email) {
  const normalized = normalizeEmail(email);
  const protectedEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  if (protectedEmail && normalized === protectedEmail) {
    throw new Error('Không thể xóa ADMIN_EMAIL gốc đã cấu hình trên Railway.');
  }
  const user = await admin.auth().getUserByEmail(normalized);
  const claims = { ...(user.customClaims || {}) };
  delete claims.admin;
  if (claims.role === 'admin') delete claims.role;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  await admin.auth().revokeRefreshTokens(user.uid);
  return { uid: user.uid, email: user.email || normalized };
}
function validPopupId(id) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || '').trim()); }
function parseAddPopup(text) {
  const raw = String(text || '').trim();
  const body = raw.replace(/^\/addpopup(?:@\w+)?\s*/i,'').trim();
  const args = body.split('|').map(x => x.trim());
  if (args.length !== 3) throw new Error('Cú pháp: /addpopup ID | Tiêu đề | Nội dung');
  let id, title, content;
  if (validPopupId(args[0])) [id,title,content] = args;
  else if (validPopupId(args[2])) [title,content,id] = args;
  else throw new Error('ID popup chỉ gồm chữ, số, _ hoặc -, tối đa 64 ký tự. Ví dụ: TB1');
  if (!title) throw new Error('Tiêu đề không được để trống.');
  if (!content) throw new Error('Nội dung không được để trống.');
  if (title.length > 200) throw new Error('Tiêu đề tối đa 200 ký tự.');
  if (content.length > 5000) throw new Error('Nội dung tối đa 5000 ký tự.');
  return { id, title, content };
}
function parseDeletePopup(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 2) throw new Error('Cú pháp: /deletepopup ID');
  const id = p[1].trim();
  if (!validPopupId(id)) throw new Error('ID popup không hợp lệ.');
  return id;
}
async function findUserByUsername(db, username) {
  const key = username.toLowerCase();
  const mapSnap = await db.collection('usernames').doc(key).get();
  if (mapSnap.exists && mapSnap.data()?.uid) {
    const uid = String(mapSnap.data().uid);
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (snap.exists) return { uid, ref, data: snap.data() || {} };
  }
  const exact = await db.collection('users').where('username','==',username).limit(2).get();
  if (exact.size === 1) return { uid: exact.docs[0].id, ref: exact.docs[0].ref, data: exact.docs[0].data() || {} };
  const lower = await db.collection('users').where('usernameLower','==',key).limit(2).get();
  if (lower.size === 1) return { uid: lower.docs[0].id, ref: lower.docs[0].ref, data: lower.docs[0].data() || {} };
  throw new Error(`Không tìm thấy username @${username}.`);
}
async function pay(db, admin, username, amount) {
  const user = await findUserByUsername(db, username);
  return db.runTransaction(async tx => {
    const snap = await tx.get(user.ref);
    if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
    const data = snap.data() || {};
    const rawBalance = data.balance == null || data.balance === '' ? 0 : Number(data.balance);
    if (!Number.isFinite(rawBalance) || rawBalance < 0) throw new Error('Số dư hiện tại không hợp lệ.');
    const oldBalance = Math.round(rawBalance * 100) / 100;
    const newBalance = Math.round((oldBalance + amount) * 100) / 100;
    if (!Number.isSafeInteger(Math.trunc(newBalance * 100))) throw new Error('Số dư vượt giới hạn an toàn.');
    const logRef = db.collection('balance_logs').doc();
    tx.update(user.ref, { balance:newBalance, updatedAt:admin.firestore.FieldValue.serverTimestamp() });
    tx.set(logRef, { uid:user.uid, amount, type:'credit', reason:'Admin Telegram /pay', oldBalance, newBalance, adminAction:'telegram_pay', adminUsername:username, createdAt:admin.firestore.FieldValue.serverTimestamp() });
    return { uid:user.uid, email:String(data.email||''), username:String(data.username||username), oldBalance, newBalance, amount };
  });
}
async function take(db, admin, username, amount) {
  const user = await findUserByUsername(db, username);
  return db.runTransaction(async tx => {
    const snap = await tx.get(user.ref);
    if (!snap.exists) throw new Error('Tài khoản không tồn tại.');
    const data = snap.data() || {};
    const rawBalance = data.balance == null || data.balance === '' ? 0 : Number(data.balance);
    if (!Number.isFinite(rawBalance) || rawBalance < 0) throw new Error('Số dư hiện tại không hợp lệ.');
    const oldBalance = Math.round(rawBalance * 100) / 100;
    if (oldBalance < amount) throw new Error(`Số dư @${username} không đủ. Hiện có ${money(oldBalance)}, cần trừ ${money(amount)}.`);
    const newBalance = Math.round((oldBalance - amount) * 100) / 100;
    const logRef = db.collection('balance_logs').doc();
    tx.update(user.ref, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(logRef, { uid: user.uid, amount: -amount, type: 'debit', reason: 'Admin Telegram /take', oldBalance, newBalance, adminAction: 'telegram_take', adminUsername: username, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { uid:user.uid, email:String(data.email||''), username:String(data.username||username), oldBalance, newBalance, amount };
  });
}
async function addPopup(db, admin, data) {
  const ref = db.collection('popups').doc(data.id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new Error(`Popup ID ${data.id} đã tồn tại.`);
    tx.create(ref,{...data,active:true,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  });
}
async function deletePopup(db,id) {
  const ref=db.collection('popups').doc(id);
  await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error(`Không tìm thấy popup ${id}.`);tx.delete(ref);});
}
async function sendHelp(chatId) {
  return telegram('sendMessage',{chat_id:chatId,text:'<b>TDMS1VN ADMIN BOT</b>\n\n/pay username số_tiền\n/take username số_tiền\n/addadmin gmail@example.com\n/listadmin\n/deleteadmin gmail@example.com\n/addpopup ID | Tiêu đề | Nội dung\n/deletepopup ID\n/help\n\nVí dụ:\n/pay hung123 50000\n/take hung123 50000\n/addadmin admin2@gmail.com\n/listadmin\n/deleteadmin admin2@gmail.com\n/addpopup TB1 | Khuyến mãi | Nội dung thông báo\n/deletepopup TB1',parse_mode:'HTML'});
}
async function handleMessage(message,db,admin) {
  const chatId=String(message?.chat?.id||''); const text=String(message?.text||'').trim(); if(!text.startsWith('/'))return;
  const command=text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if(command==='/start'||command==='/help')return sendHelp(chatId);
  if(command==='/pay'){const {username,amount}=parsePay(text);const r=await pay(db,admin,username,amount);return telegram('sendMessage',{chat_id:chatId,text:`✅ <b>CỘNG TIỀN THÀNH CÔNG</b>\n\n👤 Username: <code>@${esc(r.username)}</code>\n📧 Gmail: <code>${esc(r.email||'—')}</code>\n💰 Cộng: <b>${money(r.amount)}</b>\n💳 Số dư cũ: ${money(r.oldBalance)}\n💳 Số dư mới: <b>${money(r.newBalance)}</b>`,parse_mode:'HTML'});}
  if(command==='/take'){const {username,amount}=parseTake(text);const r=await take(db,admin,username,amount);return telegram('sendMessage',{chat_id:chatId,text:`✅ <b>TRỪ TIỀN THÀNH CÔNG</b>\n\n👤 Username: <code>@${esc(r.username)}</code>\n📧 Gmail: <code>${esc(r.email||'—')}</code>\n💸 Trừ: <b>${money(r.amount)}</b>\n💳 Số dư cũ: ${money(r.oldBalance)}\n💳 Số dư mới: <b>${money(r.newBalance)}</b>`,parse_mode:'HTML'});}
  if(command==='/addadmin'){
    const email=parseAdminEmailCommand(text,'/addadmin');
    const r=await addAdmin(admin,email);
    return telegram('sendMessage',{chat_id:chatId,text:`✅ <b>ĐÃ THÊM ADMIN</b>\n\n📧 Gmail: <code>${esc(r.email)}</code>\n🆔 UID: <code>${esc(r.uid)}</code>\n\n⚠️ Tài khoản cần đăng nhập lại để nhận custom claim mới.`,parse_mode:'HTML'});
  }
  if(command==='/listadmin'){
    const admins=await listAdmins(admin);
    if(!admins.length) return telegram('sendMessage',{chat_id:chatId,text:'⚠️ Chưa có tài khoản Admin nào.'});
    const body=admins.map((x,i)=>`${i+1}. <b>${esc(x.email||'—')}</b>${x.displayName?` — ${esc(x.displayName)}`:''}\n   UID: <code>${esc(x.uid)}</code>\n   ${x.disabled?'🔒 Disabled':'✅ Active'} · ${x.emailVerified?'✓ Verified':'⚠️ Chưa verify'}`).join('\n\n');
    return telegram('sendMessage',{chat_id:chatId,text:`<b>👑 DANH SÁCH ADMIN (${admins.length})</b>\n\n${body}`,parse_mode:'HTML'});
  }
  if(command==='/deleteadmin'){
    const email=parseAdminEmailCommand(text,'/deleteadmin');
    const r=await deleteAdmin(admin,email);
    return telegram('sendMessage',{chat_id:chatId,text:`🗑️ <b>ĐÃ XÓA QUYỀN ADMIN</b>\n\n📧 Gmail: <code>${esc(r.email)}</code>\n🆔 UID: <code>${esc(r.uid)}</code>`,parse_mode:'HTML'});
  }
  if(command==='/addpopup'){const data=parseAddPopup(text);await addPopup(db,admin,data);return telegram('sendMessage',{chat_id:chatId,text:`✅ <b>ĐÃ THÊM POPUP</b>\n\n🆔 ID: <code>${esc(data.id)}</code>\n📌 Tiêu đề: <b>${esc(data.title)}</b>\n📝 Nội dung: ${esc(data.content)}`,parse_mode:'HTML'});}
  if(command==='/deletepopup'){const id=parseDeletePopup(text);await deletePopup(db,id);return telegram('sendMessage',{chat_id:chatId,text:`🗑️ Đã xóa popup <code>${esc(id)}</code>.`,parse_mode:'HTML'});}
  return sendHelp(chatId);
}
async function handleUpdate(update,db,admin){if(!update?.message)return;const chatId=String(update.message.chat?.id||'');if(!isAuthorized(update)){if(chatId)await telegram('sendMessage',{chat_id:chatId,text:'⛔ Bạn không có quyền sử dụng bot admin.'}).catch(()=>{});return;}try{await handleMessage(update.message,db,admin);}catch(error){console.error('Admin bot command:',error);await telegram('sendMessage',{chat_id:chatId,text:`❌ ${error.message||'Có lỗi xảy ra.'}`}).catch(()=>{});}}
async function startAdminBot(db,admin){
  if(started)return;
  if(!String(process.env.ADMIN_TELEGRAM_BOT_TOKEN||'').trim()){console.log('Admin Telegram bot disabled: ADMIN_TELEGRAM_BOT_TOKEN is not configured');return;}
  if(!configuredUsers().length&&!configuredChat()){console.error('Admin Telegram bot disabled: set ADMIN_TELEGRAM_USER_IDS or ADMIN_TELEGRAM_CHAT_ID');return;}
  started=true;
  try{
    const me=await telegram('getMe',{}); console.log(`Admin Telegram bot connected: @${me.username||me.first_name||'unknown'}`);
    await telegram('deleteWebhook',{drop_pending_updates:true});
    offset=0;
    while(started){
      try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const u of updates||[]){offset=Number(u.update_id)+1;await handleUpdate(u,db,admin);}}
      catch(error){
        const telegramError = error.response?.data || {};
        console.error('Admin Telegram polling:', telegramError.description || error.message);
        if (Number(telegramError.error_code) === 409) {
          console.error('Admin Telegram bot stopped: this token is already being polled by another process.');
          started = false;
          break;
        }
        await new Promise(r=>setTimeout(r,3000));
      }
    }
  }catch(error){started=false;console.error('Admin Telegram startup failed:',error.response?.data||error.message);}
}
module.exports={startAdminBot,parsePay,parseTake,parseAddPopup,parseDeletePopup,parseAdminEmailCommand,validEmail};
