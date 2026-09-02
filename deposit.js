const express = require('express');
const axios = require('axios');
const router = express.Router();

const DEFAULT_CARD_TYPES = ['Viettel','Vinaphone','Mobifone','Vietnamobile','Zing','Gate','Garena','Vcoin','Funtap'];
const DEFAULT_AMOUNTS = [10000,20000,30000,50000,100000,200000,300000,500000,1000000];

function configuredCardTypes() {
  const raw = String(process.env.CARD_TYPES || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_CARD_TYPES).map(v => v.trim()).filter(Boolean));
}
function configuredAmounts() {
  const raw = String(process.env.CARD_DENOMINATIONS || '').trim();
  const values = (raw ? raw.split(',') : DEFAULT_AMOUNTS).map(v => Number.parseInt(v.trim(),10)).filter(Number.isSafeInteger);
  return new Set(values.length ? values : DEFAULT_AMOUNTS);
}
function requireUser(req,res,next){ return req.app.locals.verifyToken(req,res,next); }
function h(value){ return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function telegramClient(){
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if(!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return axios.create({baseURL:`https://api.telegram.org/bot${token}`,timeout:15000});
}
async function telegram(method,payload){ return (await telegramClient().post(`/${method}`,payload)).data; }
async function notifyAdminTelegram(text,keyboard){
  const chatId=String(process.env.TELEGRAM_ADMIN_CHAT_ID||'').trim();
  if(!chatId) throw new Error('TELEGRAM_ADMIN_CHAT_ID is not configured');
  return telegram('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined});
}
function cardCredit(faceValue){ const n=Number(faceValue); return Math.round(n*0.70); }
function bankCredit(amount){ return Number(amount); }
async function getProfile(db,uid){
  const snap=await db.collection('users').doc(uid).get();
  const data=snap.exists?(snap.data()||{}):{};
  return {email:String(data.email||''),username:String(data.username||''),name:String(data.name||'')};
}

async function createDepositAndNotify({db,admin,uid,type,amount,extra}){
  const profile=await getProfile(db,uid);
  const depositRef=db.collection('deposits').doc();
  const faceValue=Number(amount);
  const creditPreview=type==='card'?cardCredit(faceValue):bankCredit(faceValue);
  const base={uid,type,amount:faceValue,creditedAmount:creditPreview,status:'Chờ duyệt',email:profile.email,username:profile.username,name:profile.name,...extra,adminNotified:false,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()};
  await depositRef.create(base);
  const lines=[
    '<b>TDMS1VN — YÊU CẦU NẠP TIỀN</b>',
    `ID: <code>${h(depositRef.id)}</code>`,
    `Gmail: <code>${h(profile.email||'—')}</code>`,
    `Username: <code>${h(profile.username||'—')}</code>`,
    `Mệnh giá: <b>${faceValue.toLocaleString('vi-VN')}đ</b>`,
    type==='card'?`Loại thẻ: <b>${h(extra.cardType)}</b>`:'Phương thức: <b>Chuyển khoản ngân hàng</b>',
    type==='card'?`Số Seri: <code>${h(extra.serial)}</code>`:'',
    type==='card'?`Mã thẻ: <code>${h(extra.code)}</code>`:'',
    type==='card'?`Thực nhận sau CK 30%: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>`:`Thực nhận 100%: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>`
  ].filter(Boolean).join('\n');
  const keyboard=[[{text:'✅ Duyệt',callback_data:`deposit:approve:${depositRef.id}`},{text:'❌ Thất bại',callback_data:`deposit:reject:${depositRef.id}`}]];
  let notified=false,lastError='';
  for(let attempt=1;attempt<=3;attempt++){
    try{ await notifyAdminTelegram(lines,keyboard); notified=true; break; }
    catch(error){ lastError=error.message; console.error(`Telegram notification attempt ${attempt}:`,error.message); if(attempt<3) await new Promise(r=>setTimeout(r,1000*attempt)); }
  }
  await depositRef.update({adminNotified:notified,adminNotificationError:notified?admin.firestore.FieldValue.delete():lastError,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  // The deposit request is already safely stored. Do not make the customer resubmit because Telegram had a transient failure.
  return {id:depositRef.id,adminNotified:notified};
}

async function grantDeposit(db,admin,depositId,decision){
  const cleanId=String(depositId||'').trim();
  if(!cleanId) throw new Error('Deposit ID is required');
  if(!['approve','reject'].includes(decision)) throw new Error('Invalid deposit decision');
  const depositRef=db.collection('deposits').doc(cleanId);
  return db.runTransaction(async tx=>{
    const depSnap=await tx.get(depositRef);
    if(!depSnap.exists) throw new Error('Deposit not found');
    const dep=depSnap.data()||{};
    const status=String(dep.status||'');
    if(status==='Thành công'||status==='Thất bại') return {alreadyProcessed:true,status,amount:Number(dep.amount||0),creditedAmount:Number(dep.creditedAmount||0),uid:String(dep.uid||''),newBalance:Number(dep.newBalance||0)};
    if(decision==='reject'){
      tx.update(depositRef,{status:'Thất bại',creditedAmount:0,reviewedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return {alreadyProcessed:false,status:'Thất bại',amount:Number(dep.amount||0),creditedAmount:0,uid:String(dep.uid||'')};
    }
    const uid=String(dep.uid||'').trim(); if(!uid) throw new Error('Deposit has no user UID');
    const faceValue=Number(dep.amount); if(!Number.isFinite(faceValue)||faceValue<=0) throw new Error('Deposit amount is invalid');
    const credit=dep.type==='card'?cardCredit(faceValue):bankCredit(faceValue);
    if(!Number.isSafeInteger(credit)||credit<=0) throw new Error('Credit amount is invalid');
    const userRef=db.collection('users').doc(uid); const userSnap=await tx.get(userRef); if(!userSnap.exists) throw new Error('User account not found');
    const currentBalance=Number(userSnap.data()?.balance||0); if(!Number.isFinite(currentBalance)||currentBalance<0) throw new Error('Current balance is invalid');
    const newBalance=currentBalance+credit; if(!Number.isSafeInteger(newBalance)) throw new Error('New balance exceeds safe integer range');
    const logRef=db.collection('balance_logs').doc();
    tx.update(userRef,{balance:newBalance,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    tx.update(depositRef,{status:'Thành công',reviewedAt:admin.firestore.FieldValue.serverTimestamp(),creditedAmount:credit,oldBalance:currentBalance,newBalance,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    tx.set(logRef,{uid,amount:credit,type:'credit',reason:dep.type==='card'?`Nạp thẻ - chiết khấu 30% - ${cleanId}`:`Nạp chuyển khoản - 100% - ${cleanId}`,oldBalance:currentBalance,newBalance,depositId:cleanId,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    return {alreadyProcessed:false,status:'Thành công',amount:faceValue,creditedAmount:credit,uid,oldBalance:currentBalance,newBalance};
  });
}

router.post('/cards',requireUser,async(req,res)=>{
  const db=req.app.locals.db, admin=req.app.locals.admin, uid=req.user.uid;
  const {cardType,serial,code,amount}=req.body||{}; const normalizedAmount=Number.parseInt(amount,10);
  const type=String(cardType||'').trim(), serialClean=String(serial||'').trim(), codeClean=String(code||'').trim();
  if(!configuredCardTypes().has(type)||!configuredAmounts().has(normalizedAmount)||!serialClean||!codeClean) return res.status(400).json({error:'Loại thẻ hoặc mệnh giá không hợp lệ'});
  if(serialClean.length>100||codeClean.length>100) return res.status(400).json({error:'Thông tin thẻ quá dài'});
  try{
    // Manual admin verification only. No card gateway is called.
    const result=await createDepositAndNotify({db,admin,uid,type:'card',amount:normalizedAmount,extra:{cardType:type,serial:serialClean,code:codeClean,discountPercent:30}});
    res.status(201).json({ok:true,depositId:result.id,adminNotified:result.adminNotified,faceValue:normalizedAmount,creditedAmount:cardCredit(normalizedAmount),discountPercent:30});
  }catch(error){ console.error('deposit card:',error); res.status(500).json({error:'Không thể gửi yêu cầu nạp thẻ'}); }
});

router.post('/bank',requireUser,async(req,res)=>{
  const db=req.app.locals.db, admin=req.app.locals.admin, uid=req.user.uid; const amount=Number.parseInt(req.body?.amount,10);
  if(!Number.isSafeInteger(amount)||amount<1000||amount>100000000) return res.status(400).json({error:'Số tiền chuyển khoản không hợp lệ'});
  try{
    const result=await createDepositAndNotify({db,admin,uid,type:'bank',amount,extra:{paymentMethod:'bank_transfer',discountPercent:0,transferContent:String(uid)}});
    res.status(201).json({ok:true,depositId:result.id,adminNotified:result.adminNotified,faceValue:amount,creditedAmount:amount,discountPercent:0});
  }catch(error){ console.error('deposit bank:',error); res.status(500).json({error:'Không thể tạo yêu cầu nạp chuyển khoản'}); }
});

router.get('/',requireUser,async(req,res)=>{
  try{
    const snap=await req.app.locals.db.collection('deposits').where('uid','==',req.user.uid).limit(100).get();
    const deposits=snap.docs.map(d=>{const x={...d.data()}; delete x.code; return {id:d.id,...x};}).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    res.json({deposits});
  }catch(error){console.error('deposit list:',error);res.status(500).json({error:'Không thể lấy lịch sử nạp tiền'});}
});

async function handleTelegramUpdate(update,db,admin){
  const callback=update?.callback_query; const configuredAdminChatId=String(process.env.TELEGRAM_ADMIN_CHAT_ID||'').trim();
  if(!callback?.data) return {ignored:true};
  const chatId=String(callback.message?.chat?.id||'');
  if(!configuredAdminChatId||chatId!==configuredAdminChatId){await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:'Bạn không có quyền thao tác.',show_alert:true}).catch(()=>{});return {ignored:true};}
  const parts=String(callback.data).split(':'); if(parts.length!==3||parts[0]!=='deposit'||!['approve','reject'].includes(parts[1])){await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:'Thao tác không hợp lệ.',show_alert:true}).catch(()=>{});return {ignored:true};}
  const action=parts[1],depositId=parts[2];
  // Answer Telegram immediately so the button never spins while Firestore is working.
  await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:action==='approve'?'Đang duyệt...':'Đang đánh dấu thất bại...',show_alert:false}).catch(()=>{});
  try{
    const result=await grantDeposit(db,admin,depositId,action); const mid=callback.message?.message_id;
    if(mid){
      const text=result.alreadyProcessed?`ℹ️ <b>ĐÃ XỬ LÝ</b>\nID: <code>${h(depositId)}</code>\nTrạng thái: <b>${h(result.status)}</b>`:action==='approve'?`✅ <b>ĐÃ DUYỆT</b>\nID: <code>${h(depositId)}</code>\nMệnh giá: <b>${Number(result.amount).toLocaleString('vi-VN')}đ</b>\nCộng vào số dư: <b>${Number(result.creditedAmount).toLocaleString('vi-VN')}đ</b>\nSố dư mới: <b>${Number(result.newBalance).toLocaleString('vi-VN')}đ</b>`:`❌ <b>THẤT BẠI</b>\nID: <code>${h(depositId)}</code>\nMệnh giá: <b>${Number(result.amount).toLocaleString('vi-VN')}đ</b>`;
      try{await telegram('editMessageText',{chat_id:chatId,message_id:mid,text,parse_mode:'HTML'});}catch(e){console.error('editMessageText:',e.response?.data||e.message);await telegram('editMessageReplyMarkup',{chat_id:chatId,message_id:mid,reply_markup:{inline_keyboard:[]}}).catch(()=>{});}
    }
    return result;
  }catch(error){
    console.error('telegram deposit action:',error);
    await telegram('sendMessage',{chat_id:chatId,text:`❌ <b>Không thể xử lý</b>\nID: <code>${h(depositId)}</code>\nLỗi: ${h(error.message||'Unknown error')}`,parse_mode:'HTML'}).catch(()=>{});
    return {ok:false,error:error.message};
  }
}


let telegramPollingStarted = false;
let telegramPollingOffset = 0;

async function telegramGetUpdates(offset) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const client = telegramClient();
  const response = await client.post('/getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['callback_query']
  }, { timeout: 35000 });
  if (!response.data?.ok) throw new Error(response.data?.description || 'Telegram getUpdates failed');
  return Array.isArray(response.data.result) ? response.data.result : [];
}

async function startTelegramPolling(db, admin) {
  if (telegramPollingStarted) return;
  if (String(process.env.TELEGRAM_BOT_MODE || 'polling').trim().toLowerCase() !== 'polling') return;
  if (!String(process.env.TELEGRAM_BOT_TOKEN || '').trim()) {
    console.error('Telegram polling disabled: TELEGRAM_BOT_TOKEN is not configured');
    return;
  }
  telegramPollingStarted = true;
  console.log('Telegram bot mode: LONG POLLING');
  try {
    // Polling and webhook cannot be active at the same time. Remove any stale
    // webhook left by an older deployment so Approve/Reject callbacks always
    // arrive at this running backend.
    await telegram('deleteWebhook', { drop_pending_updates: false }).catch(error => {
      console.error('Telegram deleteWebhook:', error.response?.data || error.message);
    });

    // Start after webhook deletion. Offset is initialized from the newest update
    // so an old callback is not accidentally applied after a deployment restart.
    const pending = await telegramGetUpdates(0).catch(() => []);
    if (pending.length) telegramPollingOffset = pending[pending.length - 1].update_id + 1;

    const loop = async () => {
      while (telegramPollingStarted) {
        try {
          const updates = await telegramGetUpdates(telegramPollingOffset);
          for (const update of updates) {
            telegramPollingOffset = Number(update.update_id) + 1;
            try {
              await handleTelegramUpdate(update, db, admin);
            } catch (error) {
              console.error('Telegram update processing:', error);
            }
          }
        } catch (error) {
          console.error('Telegram polling:', error.response?.data || error.message);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    };
    loop().catch(error => console.error('Telegram polling loop stopped:', error));
  } catch (error) {
    telegramPollingStarted = false;
    console.error('Telegram polling startup failed:', error);
  }
}

router.post('/telegram/webhook',(req,res)=>{
  const secret=String(process.env.TELEGRAM_WEBHOOK_SECRET||'').trim();
  if(secret&&req.get('X-Telegram-Bot-Api-Secret-Token')!==secret)return res.status(401).json({error:'Invalid secret'});
  // Telegram expects a quick 2xx response. Process the update after responding.
  res.status(200).json({ok:true});
  setImmediate(()=>handleTelegramUpdate(req.body,req.app.locals.db,req.app.locals.admin).catch(error=>console.error('telegram webhook async:',error)));
});

module.exports=router;
module.exports.grantDeposit=grantDeposit;
module.exports.startTelegramPolling=startTelegramPolling;
