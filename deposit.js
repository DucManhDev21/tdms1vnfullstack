const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

const DEFAULT_CARD_TYPES = ['Viettel', 'Vinaphone', 'Mobifone', 'Vietnamobile', 'Zing', 'Gate', 'Garena'];
const DEFAULT_AMOUNTS = [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000];

function configuredCardTypes() {
  const raw = String(process.env.CARD_TYPES || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_CARD_TYPES).map(v => v.trim()).filter(Boolean));
}
function configuredAmounts() {
  const raw = String(process.env.CARD_DENOMINATIONS || '').trim();
  const values = (raw ? raw.split(',') : DEFAULT_AMOUNTS).map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isInteger(v) && v > 0);
  return new Set(values.length ? values : DEFAULT_AMOUNTS);
}
function requireUser(req, res, next) { return req.app.locals.verifyToken(req, res, next); }
function h(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function telegramClient() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return axios.create({ baseURL: `https://api.telegram.org/bot${token}`, timeout: 15000 });
}
async function telegram(method, payload) { return (await telegramClient().post(`/${method}`, payload)).data; }
async function notifyAdminTelegram(text, keyboard) {
  const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (!chatId) throw new Error('TELEGRAM_ADMIN_CHAT_ID is not configured');
  return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined });
}
function cardCredit(faceValue) {
  const n = Number(faceValue);
  return Math.round(n * 0.70); // thẻ cào: chiết khấu 30%
}
function bankCredit(amount) {
  return Number(amount); // chuyển khoản: 100%, không chiết khấu
}
async function getProfile(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  return { email: String(data.email || ''), username: String(data.username || ''), name: String(data.name || '') };
}

async function grantDeposit(db, admin, depositId, decision) {
  const cleanId = String(depositId || '').trim();
  if (!cleanId) throw new Error('Deposit ID is required');
  if (!['approve', 'reject'].includes(decision)) throw new Error('Invalid deposit decision');
  const depositRef = db.collection('deposits').doc(cleanId);
  return db.runTransaction(async tx => {
    const depSnap = await tx.get(depositRef);
    if (!depSnap.exists) throw new Error('Deposit not found');
    const dep = depSnap.data() || {};
    const status = String(dep.status || '');
    if (status === 'Thành công' || status === 'Thất bại') {
      return { alreadyProcessed: true, status, amount: Number(dep.amount || 0), creditedAmount: Number(dep.creditedAmount || 0), uid: String(dep.uid || ''), newBalance: Number(dep.newBalance || 0) };
    }
    if (decision === 'reject') {
      tx.update(depositRef, { status: 'Thất bại', creditedAmount: 0, reviewedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { alreadyProcessed: false, status: 'Thất bại', amount: Number(dep.amount || 0), creditedAmount: 0, uid: String(dep.uid || '') };
    }
    const uid = String(dep.uid || '').trim();
    if (!uid) throw new Error('Deposit has no user UID');
    const faceValue = Number(dep.amount);
    if (!Number.isFinite(faceValue) || faceValue <= 0) throw new Error('Deposit amount is invalid');
    const credit = dep.type === 'card' ? cardCredit(faceValue) : bankCredit(faceValue);
    if (!Number.isSafeInteger(credit) || credit <= 0) throw new Error('Credit amount is invalid');
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User account not found');
    const currentBalance = Number(userSnap.data()?.balance || 0);
    if (!Number.isFinite(currentBalance) || currentBalance < 0) throw new Error('Current balance is invalid');
    const newBalance = currentBalance + credit;
    const logRef = db.collection('balance_logs').doc();
    tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(depositRef, {
      status: 'Thành công', reviewedAt: admin.firestore.FieldValue.serverTimestamp(), creditedAmount: credit,
      oldBalance: currentBalance, newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(logRef, { uid, amount: credit, type: 'credit', reason: dep.type === 'card' ? `Nạp thẻ - chiết khấu 30% - ${cleanId}` : `Nạp chuyển khoản - 100% - ${cleanId}`, oldBalance: currentBalance, newBalance, depositId: cleanId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { alreadyProcessed: false, status: 'Thành công', amount: faceValue, creditedAmount: credit, uid, oldBalance: currentBalance, newBalance };
  });
}

async function createDepositAndNotify({ db, admin, uid, type, amount, extra }) {
  const profile = await getProfile(db, uid);
  const depositRef = db.collection('deposits').doc();
  const creditPreview = type === 'card' ? cardCredit(amount) : bankCredit(amount);
  await depositRef.create({
    uid, type, amount: Number(amount), creditedAmount: creditPreview, status: 'Chờ duyệt',
    email: profile.email, username: profile.username, name: profile.name,
    ...extra, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const lines = [
    '<b>TDMS1VN — YÊU CẦU NẠP TIỀN</b>',
    `ID: <code>${h(depositRef.id)}</code>`,
    `Gmail: <code>${h(profile.email || '—')}</code>`,
    `Username: <code>${h(profile.username || '—')}</code>`,
    `Mệnh giá: <b>${Number(amount).toLocaleString('vi-VN')}đ</b>`,
    type === 'card' ? `Loại thẻ: <b>${h(extra.cardType)}</b>` : 'Phương thức: <b>Chuyển khoản ngân hàng</b>',
    type === 'card' ? `Số Seri: <code>${h(extra.serial)}</code>` : '',
    type === 'card' ? `Mã thẻ: <code>${h(extra.code)}</code>` : '',
    type === 'card' ? `Thực nhận sau CK 30%: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>` : `Thực nhận: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>`
  ].filter(Boolean).join('\n');
  await notifyAdminTelegram(lines, [[
    { text: '✅ Duyệt', callback_data: `deposit:approve:${depositRef.id}` },
    { text: '❌ Thất bại', callback_data: `deposit:reject:${depositRef.id}` }
  ]]);
  return depositRef.id;
}

router.post('/cards', requireUser, async (req, res) => {
  const db = req.app.locals.db; const admin = req.app.locals.admin; const uid = req.user.uid;
  const { cardType, serial, code, amount } = req.body || {};
  const normalizedAmount = Number.parseInt(amount, 10);
  if (!configuredCardTypes().has(String(cardType)) || !configuredAmounts().has(normalizedAmount) || !String(serial || '').trim() || !String(code || '').trim()) return res.status(400).json({ error: 'Loại thẻ hoặc mệnh giá không hợp lệ' });
  if (String(serial).length > 100 || String(code).length > 100) return res.status(400).json({ error: 'Thông tin thẻ quá dài' });
  try {
    const serialClean = String(serial).trim();
    const codeClean = String(code).trim();
    const depositId = await createDepositAndNotify({ db, admin, uid, type: 'card', amount: normalizedAmount, extra: { cardType: String(cardType), serial: serialClean, code: codeClean, discountPercent: 30 } });
    let gateway = null;
    if (process.env.DEPOSIT_GATEWAY_URL) {
      try {
        const response = await axios.post(process.env.DEPOSIT_GATEWAY_URL, {
          partner_id: process.env.DEPOSIT_GATEWAY_PARTNER_ID || '',
          partner_key: process.env.DEPOSIT_GATEWAY_PARTNER_KEY || '',
          telco: String(cardType), amount: normalizedAmount, serial: serialClean, code: codeClean,
          request_id: depositId, callback_url: process.env.DEPOSIT_CALLBACK_URL || ''
        }, { timeout: 20000 });
        gateway = response.data;
        const statusText = String(gateway?.status || gateway?.message || '').toLowerCase();
        const failed = ['fail','failed','error','invalid','incorrect'].some(x => statusText.includes(x));
        await db.collection('deposits').doc(depositId).update({ gatewayResponse: gateway, gatewayVerified: !failed, status: failed ? 'Thất bại' : 'Chờ Admin duyệt', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (gatewayError) {
        console.error('card gateway:', gatewayError.response?.data || gatewayError.message);
        await db.collection('deposits').doc(depositId).update({ gatewayError: gatewayError.response?.data || gatewayError.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    res.status(201).json({ ok: true, depositId, faceValue: normalizedAmount, creditedAmount: cardCredit(normalizedAmount), discountPercent: 30, gateway });
  } catch (error) { console.error('deposit card:', error); res.status(500).json({ error: 'Không thể gửi yêu cầu nạp thẻ' }); }
});

router.post('/bank', requireUser, async (req, res) => {
  const db = req.app.locals.db; const admin = req.app.locals.admin; const uid = req.user.uid;
  const amount = Number.parseInt(req.body?.amount, 10);
  if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000) return res.status(400).json({ error: 'Số tiền chuyển khoản không hợp lệ' });
  try {
    const depositId = await createDepositAndNotify({ db, admin, uid, type: 'bank', amount, extra: { paymentMethod: 'bank_transfer', discountPercent: 0, transferContent: String(uid) } });
    res.status(201).json({ ok: true, depositId, faceValue: amount, creditedAmount: amount, discountPercent: 0 });
  } catch (error) { console.error('deposit bank:', error); res.status(500).json({ error: 'Không thể tạo yêu cầu nạp chuyển khoản' }); }
});

router.get('/', requireUser, async (req, res) => {
  try {
    const snap = await req.app.locals.db.collection('deposits').where('uid', '==', req.user.uid).limit(100).get();
    const deposits = snap.docs.map(d => { const x = d.data() || {}; delete x.code; return { id: d.id, ...x }; }).sort((a,b) => (b.createdAt?.toMillis?.() || new Date(b.createdAt || 0).getTime()) - (a.createdAt?.toMillis?.() || new Date(a.createdAt || 0).getTime()));
    res.json({ deposits });
  } catch (error) { console.error('deposit list:', error); res.status(500).json({ error: 'Không thể lấy lịch sử nạp tiền' }); }
});

router.post('/gateway/callback', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const signature = req.get('X-Deposit-Signature') || ''; const secret = process.env.DEPOSIT_WEBHOOK_SECRET || '';
  if (secret) { const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex'); const a=Buffer.from(signature), b=Buffer.from(expected); if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).send('invalid signature'); }
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('invalid json'); }
  const depositId = String(payload.request_id || payload.deposit_id || '').trim(); if (!depositId) return res.status(400).send('missing request id');
  const success = ['success','completed','approved','1'].includes(String(payload.status || '').toLowerCase());
  try { await req.app.locals.db.collection('deposits').doc(depositId).update({ gatewayCallback: payload, gatewayVerified: success, status: success ? 'Chờ Admin duyệt' : 'Thất bại', updatedAt: req.app.locals.admin.firestore.FieldValue.serverTimestamp() }); res.json({ ok: true }); }
  catch (error) { console.error('gateway callback:', error); res.status(500).send('error'); }
});

async function handleTelegramUpdate(update, db, admin) {
  const callback = update?.callback_query; const configuredAdminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (update?.message?.text) {
    const chatId = String(update.message.chat?.id || '');
    if (configuredAdminChatId && chatId === configuredAdminChatId) {
      const text = update.message.text.trim();
      if (text.startsWith('/addpopup ')) { const parts=text.slice(10).trim().split('|').map(v=>v.trim()); if(parts.length<3) throw new Error('Format: /addpopup title | content | id'); await db.collection('popups').doc(parts[2]).set({id:parts[2],title:parts[0],content:parts[1],createdAt:admin.firestore.FieldValue.serverTimestamp()}); await telegram('sendMessage',{chat_id:chatId,text:`✅ Đã thêm popup ${h(parts[2])}`,parse_mode:'HTML'}); }
      if (text.startsWith('/deletepopup ')) { const id=text.slice(14).trim(); if(!id) throw new Error('Missing popup id'); await db.collection('popups').doc(id).delete(); await telegram('sendMessage',{chat_id:chatId,text:`✅ Đã xóa popup ${h(id)}`}); }
    }
  }
  if (!callback?.data) return { ignored: true };
  const chatId = String(callback.message?.chat?.id || '');
  if (!configuredAdminChatId || chatId !== configuredAdminChatId) { await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:'Bạn không có quyền thao tác.',show_alert:true}).catch(e=>console.error('answer unauthorized:',e.message)); return {ignored:true}; }
  const parts=String(callback.data).split(':');
  if(parts.length!==3 || parts[0]!=='deposit' || !['approve','reject'].includes(parts[1])) { await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:'Thao tác không hợp lệ.',show_alert:true}).catch(()=>{}); return {ignored:true}; }
  const action=parts[1], depositId=parts[2];
  // Always answer immediately; the Firestore transaction can take longer.
  await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:action==='approve'?'Đang duyệt...':'Đang đánh dấu thất bại...'}).catch(e=>console.error('answer callback:',e.message));
  try {
    const result=await grantDeposit(db,admin,depositId,action); const mid=callback.message?.message_id;
    if(mid) {
      const text=result.alreadyProcessed ? `ℹ️ <b>ĐÃ XỬ LÝ</b>\nID: <code>${h(depositId)}</code>\nTrạng thái: <b>${h(result.status)}</b>` : action==='approve' ? `✅ <b>ĐÃ DUYỆT</b>\nID: <code>${h(depositId)}</code>\nMệnh giá: <b>${Number(result.amount).toLocaleString('vi-VN')}đ</b>\nCộng vào số dư: <b>${Number(result.creditedAmount).toLocaleString('vi-VN')}đ</b>\nSố dư mới: <b>${Number(result.newBalance).toLocaleString('vi-VN')}đ</b>` : `❌ <b>THẤT BẠI</b>\nID: <code>${h(depositId)}</code>`;
      try { await telegram('editMessageText',{chat_id:chatId,message_id:mid,text,parse_mode:'HTML',reply_markup:{inline_keyboard:[]}}); }
      catch(e) { console.error('editMessageText:',e.response?.data||e.message); await telegram('editMessageReplyMarkup',{chat_id:chatId,message_id:mid,reply_markup:{inline_keyboard:[]}}).catch(()=>{}); }
    }
    return result;
  } catch(error) {
    console.error('telegram deposit action:',error);
    await telegram('sendMessage',{chat_id:chatId,text:`❌ <b>Không thể xử lý</b>\nID: <code>${h(depositId)}</code>\nLỗi: ${h(error.message || 'Unknown error')}`,parse_mode:'HTML'}).catch(()=>{});
    return {ok:false,error:error.message};
  }
}

router.post('/telegram/webhook', express.json({limit:'128kb'}), async (req,res) => {
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  if(secret && req.get('X-Telegram-Bot-Api-Secret-Token')!==secret) return res.status(401).json({error:'Invalid secret'});
  try { await handleTelegramUpdate(req.body,req.app.locals.db,req.app.locals.admin); res.json({ok:true}); }
  catch(error) { console.error('telegram webhook:',error); res.json({ok:true,handled:false}); }
});

module.exports = router;
module.exports.grantDeposit = grantDeposit;
