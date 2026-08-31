const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const router = express.Router();

const cardTypes = new Set([
  'Viettel',
  'Vinaphone',
  'Mobifone',
  'Zing',
  'Gate'
]);

const amounts = new Set([
  10000,
  20000,
  30000,
  50000,
  100000,
  200000,
  300000,
  500000,
  1000000
]);

function requireUser(req, res, next) {
  const verifyToken = req.app.locals.verifyToken;

  if (typeof verifyToken !== 'function') {
    return res.status(500).json({
      error: 'Auth middleware is not configured'
    });
  }

  return verifyToken(req, res, next);
}

function isConfiguredAdminChat(chatId) {
  const configured = String(
    process.env.TELEGRAM_ADMIN_CHAT_ID || ''
  ).trim();

  return Boolean(configured) && String(chatId) === configured;
}

function signPayload(raw) {
  const secret =
    process.env.DEPOSIT_WEBHOOK_SECRET || '';

  return crypto
    .createHmac('sha256', secret)
    .update(raw)
    .digest('hex');
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function telegramClient() {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not configured'
    );
  }

  return axios.create({
    baseURL:
      `https://api.telegram.org/bot${token}`,
    timeout: 15000
  });
}

async function telegramAnswerCallback(
  callbackQueryId,
  text,
  showAlert = false
) {
  if (!callbackQueryId) {
    return;
  }

  const client = telegramClient();

  await client.post(
    '/answerCallbackQuery',
    {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    }
  );
}

async function notifyAdminTelegram(
  text,
  keyboard
) {
  const chatId =
    process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!chatId) {
    throw new Error(
      'TELEGRAM_ADMIN_CHAT_ID is not configured'
    );
  }

  const client = telegramClient();

  await client.post(
    '/sendMessage',
    {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard
        ? {
            inline_keyboard: keyboard
          }
        : undefined
    }
  );
}

async function grantDeposit(
  db,
  admin,
  depositId,
  decision
) {
  const depositRef =
    db.collection('deposits').doc(depositId);

  return db.runTransaction(
    async tx => {
      const depSnap =
        await tx.get(depositRef);

      if (!depSnap.exists) {
        throw Object.assign(
          new Error('Deposit not found'),
          { code: 'DEPOSIT_NOT_FOUND' }
        );
      }

      const dep =
        depSnap.data();

      if (dep.status === 'Thành công') {
        return {
          alreadyProcessed: true,
          status: dep.status,
          credited: Number(dep.amount || 0)
        };
      }

      if (dep.status === 'Thất bại') {
        return {
          alreadyProcessed: true,
          status: dep.status,
          credited: 0
        };
      }

      if (!['approve', 'reject'].includes(decision)) {
        throw new Error(
          'Invalid deposit decision'
        );
      }

      if (decision === 'reject') {
        tx.update(
          depositRef,
          {
            status: 'Thất bại',
            reviewedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          }
        );

        return {
          alreadyProcessed: false,
          status: 'Thất bại',
          credited: 0
        };
      }

      const credit =
        Number(dep.amount);

      if (!Number.isFinite(credit) || credit <= 0) {
        throw new Error(
          'Invalid deposit amount'
        );
      }

      const userRef =
        db.collection('users').doc(
          String(dep.uid)
        );

      const userSnap =
        await tx.get(userRef);

      if (!userSnap.exists) {
        throw Object.assign(
          new Error('User not found'),
          { code: 'USER_NOT_FOUND' }
        );
      }

      const currentBalance =
        Number(
          userSnap.data().balance || 0
        );

      const newBalance =
        currentBalance + credit;

      tx.update(
        userRef,
        {
          balance: newBalance,
          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        }
      );

      tx.update(
        depositRef,
        {
          status: 'Thành công',
          creditedAmount: credit,
          reviewedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        }
      );

      const logRef =
        db.collection('balance_logs').doc();

      tx.set(
        logRef,
        {
          uid: dep.uid,
          amount: credit,
          type: 'credit',
          reason:
            `Duyệt nạp tiền ${depositId}`,
          oldBalance: currentBalance,
          newBalance,
          depositId,
          createdAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        }
      );

      return {
        alreadyProcessed: false,
        status: 'Thành công',
        credited: credit,
        newBalance
      };
    }
  );
}

router.post(
  '/cards',
  requireUser,
  async (req, res) => {
    const db = req.app.locals.db;
    const admin = req.app.locals.admin;
    const uid = req.user?.uid;

    if (!uid) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    const {
      cardType,
      serial,
      code,
      amount
    } = req.body || {};

    const normalizedAmount =
      Number.parseInt(amount, 10);

    const cleanCardType =
      String(cardType || '').trim();

    const cleanSerial =
      String(serial || '').trim();

    const cleanCode =
      String(code || '').trim();

    if (
      !cardTypes.has(cleanCardType) ||
      !amounts.has(normalizedAmount) ||
      !cleanSerial ||
      !cleanCode
    ) {
      return res.status(400).json({
        error: 'Thông tin thẻ không hợp lệ'
      });
    }

    if (
      cleanSerial.length > 100 ||
      cleanCode.length > 100
    ) {
      return res.status(400).json({
        error: 'Thông tin thẻ quá dài'
      });
    }

    try {
      const fingerprint =
        crypto
          .createHash('sha256')
          .update(
            `${uid}|${cleanCardType}|${cleanSerial}|${cleanCode}|${normalizedAmount}`
          )
          .digest('hex');

      const depositRef =
        db.collection('deposits').doc(
          fingerprint
        );

      const createResult =
        await db.runTransaction(
          async tx => {
            const existing =
              await tx.get(depositRef);

            if (existing.exists) {
              return {
                created: false,
                data: existing.data()
              };
            }

            tx.create(
              depositRef,
              {
                uid,
                type: 'card',
                cardType: cleanCardType,
                serial: cleanSerial,
                code: cleanCode,
                amount: normalizedAmount,
                status: 'Chờ duyệt',
                createdAt:
                  admin.firestore.FieldValue
                    .serverTimestamp()
              }
            );

            return {
              created: true,
              data: null
            };
          }
        );

      if (!createResult.created) {
        return res.status(409).json({
          error: 'Thẻ này đã được gửi trước đó',
          depositId: depositRef.id
        });
      }

      let gatewayResult = null;

      if (
        process.env.DEPOSIT_GATEWAY_URL
      ) {
        const gatewayResponse =
          await axios.post(
            process.env.DEPOSIT_GATEWAY_URL,
            {
              partner_id:
                process.env
                  .DEPOSIT_GATEWAY_PARTNER_ID ||
                '',
              partner_key:
                process.env
                  .DEPOSIT_GATEWAY_PARTNER_KEY ||
                '',
              telco: cleanCardType,
              amount: normalizedAmount,
              serial: cleanSerial,
              code: cleanCode,
              request_id:
                depositRef.id,
              callback_url:
                process.env
                  .DEPOSIT_CALLBACK_URL ||
                ''
            },
            {
              timeout: 20000
            }
          );

        gatewayResult =
          gatewayResponse.data;

        await depositRef.update({
          gatewayResponse: gatewayResult,
          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        });
      }

      const safeSerial =
        cleanSerial
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

      const text =
        `<b>TDMS1VN - Nạp thẻ</b>\n` +
        `ID: <code>${depositRef.id}</code>\n` +
        `User: <code>${uid}</code>\n` +
        `Loại: ${cleanCardType}\n` +
        `Mệnh giá: ${normalizedAmount.toLocaleString('vi-VN')}đ\n` +
        `Seri: <code>${safeSerial}</code>`;

      try {
        await notifyAdminTelegram(
          text,
          [
            [
              {
                text: '✅ Duyệt',
                callback_data:
                  `deposit:approve:${depositRef.id}`
              },
              {
                text: '❌ Không duyệt',
                callback_data:
                  `deposit:reject:${depositRef.id}`
              }
            ]
          ]
        );
      } catch (telegramError) {
        await depositRef.update({
          telegramNotifyError:
            telegramError.message,
          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        });

        return res.status(201).json({
          ok: true,
          depositId: depositRef.id,
          gateway: gatewayResult,
          warning:
            'Đã tạo yêu cầu nhưng chưa gửi được thông báo Telegram'
        });
      }

      return res.status(201).json({
        ok: true,
        depositId: depositRef.id,
        gateway: gatewayResult
      });
    } catch (error) {
      console.error(
        'deposit card:',
        error
      );

      return res.status(500).json({
        error:
          'Không thể gửi yêu cầu nạp thẻ'
      });
    }
  }
);

router.get(
  '/',
  requireUser,
  async (req, res) => {
    const db = req.app.locals.db;
    const uid = req.user?.uid;

    if (!uid) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    try {
      const snap =
        await db
          .collection('deposits')
          .where('uid', '==', uid)
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();

      return res.json({
        deposits:
          snap.docs.map(document => {
            const data =
              document.data();

            return {
              id: document.id,
              ...data,
              code: undefined
            };
          })
      });
    } catch (error) {
      console.error(
        'deposit list:',
        error
      );

      return res.status(500).json({
        error:
          error.code === 9
            ? 'Firestore thiếu composite index cho deposits(uid, createdAt).'
            : 'Không thể lấy lịch sử nạp tiền'
      });
    }
  }
);

router.post(
  '/gateway/callback',
  async (req, res) => {
    const raw =
      Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(
            JSON.stringify(req.body || {}),
            'utf8'
          );

    const signature =
      req.get('X-Deposit-Signature') || '';

    const secret =
      process.env.DEPOSIT_WEBHOOK_SECRET || '';

    if (!secret) {
      return res.status(503).send(
        'webhook secret not configured'
      );
    }

    const expected =
      signPayload(raw.toString('utf8'));

    if (
      !signature ||
      !safeEqualHex(
        signature,
        expected
      )
    ) {
      return res.status(401).send(
        'invalid signature'
      );
    }

    let payload;

    try {
      payload =
        JSON.parse(
          raw.toString('utf8')
        );
    } catch {
      return res.status(400).send(
        'invalid json'
      );
    }

    const db = req.app.locals.db;
    const admin = req.app.locals.admin;

    const depositId =
      String(
        payload.request_id ||
        payload.deposit_id ||
        ''
      );

    if (!depositId) {
      return res.status(400).send(
        'missing request id'
      );
    }

    const status =
      String(
        payload.status || ''
      ).toLowerCase();

    const success =
      [
        'success',
        'completed',
        'approved',
        '1'
      ].includes(status);

    try {
      if (!success) {
        await db.collection('deposits')
          .doc(depositId)
          .update({
            gatewayCallback: payload,
            status: 'Thất bại',
            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          });

        return res.json({
          ok: true,
          status: 'Thất bại'
        });
      }

      const result =
        await grantDeposit(
          db,
          admin,
          depositId,
          'approve'
        );

      await db.collection('deposits')
        .doc(depositId)
        .update({
          gatewayCallback: payload,
          gatewayConfirmedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        });

      return res.json({
        ok: true,
        status: result.status,
        credited: result.credited
      });
    } catch (error) {
      console.error(
        'gateway callback:',
        error
      );

      return res.status(500).send(
        'error'
      );
    }
  }
);

async function handleTelegramUpdate(
  update,
  db,
  admin
) {
  const message =
    update?.message;

  const callback =
    update?.callback_query;

  if (message?.text) {
    const chatId =
      String(message.chat?.id || '');

    if (!isConfiguredAdminChat(chatId)) {
      return;
    }

    const text =
      message.text.trim();

    if (
      text.startsWith('/addpopup ')
    ) {
      const payload =
        text.slice(10).trim();

      const parts =
        payload
          .split('|')
          .map(value => value.trim());

      if (parts.length < 3) {
        throw new Error(
          'Format: /addpopup title | content | id'
        );
      }

      const [
        title,
        content,
        id
      ] = parts;

      if (
        !title ||
        !content ||
        !id ||
        id.length > 120
      ) {
        throw new Error(
          'Popup data is invalid'
        );
      }

      await db
        .collection('popups')
        .doc(id)
        .set(
          {
            id,
            title,
            content,
            createdAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

      await telegramClient().post(
        '/sendMessage',
        {
          chat_id: chatId,
          text:
            `✅ Đã thêm/cập nhật popup <code>${id}</code>`,
          parse_mode: 'HTML'
        }
      );

      return;
    }

    if (
      text.startsWith('/deletepopup ')
    ) {
      const id =
        text.slice(14).trim();

      if (!id) {
        throw new Error(
          'Missing popup id'
        );
      }

      await db
        .collection('popups')
        .doc(id)
        .delete();

      await telegramClient().post(
        '/sendMessage',
        {
          chat_id: chatId,
          text:
            `✅ Đã xóa popup <code>${id}</code>`,
          parse_mode: 'HTML'
        }
      );
    }
  }

  if (callback?.data) {
    const chatId =
      String(
        callback.message?.chat?.id || ''
      );

    if (!isConfiguredAdminChat(chatId)) {
      try {
        await telegramAnswerCallback(
          callback.id,
          'Bạn không có quyền thực hiện thao tác này.',
          true
        );
      } catch (error) {
        console.error(
          'unauthorized callback ack:',
          error.message
        );
      }

      return;
    }

    const parts =
      callback.data.split(':');

    if (
      parts[0] !== 'deposit' ||
      parts.length !== 3
    ) {
      await telegramAnswerCallback(
        callback.id,
        'Thao tác không hợp lệ.',
        true
      );

      return;
    }

    const action =
      parts[1];

    const depositId =
      parts[2];

    await telegramAnswerCallback(
      callback.id,
      'Đang xử lý...'
    );

    try {
      const result =
        await grantDeposit(
          db,
          admin,
          depositId,
          action === 'approve'
            ? 'approve'
            : 'reject'
        );

      const client =
        telegramClient();

      try {
        await client.post(
          '/editMessageReplyMarkup',
          {
            chat_id: chatId,
            message_id:
              callback.message
                ?.message_id,
            reply_markup: {
              inline_keyboard: []
            }
          }
        );
      } catch (editError) {
        console.error(
          'remove telegram keyboard:',
          editError.message
        );
      }

      const statusMessage =
        result.status === 'Thành công'
          ? result.alreadyProcessed
            ? 'ℹ️ Đơn này đã được xử lý trước đó.'
            : `✅ Đã duyệt. Cộng ${Number(result.credited).toLocaleString('vi-VN')}đ. Số dư mới: ${Number(result.newBalance).toLocaleString('vi-VN')}đ.`
          : result.alreadyProcessed
            ? 'ℹ️ Đơn này đã được xử lý trước đó.'
            : '❌ Đã từ chối đơn nạp.';

      await client.post(
        '/sendMessage',
        {
          chat_id: chatId,
          text: statusMessage
        }
      );
    } catch (error) {
      console.error(
        'telegram deposit action:',
        error
      );

      try {
        await telegramAnswerCallback(
          callback.id,
          'Không thể xử lý đơn này.',
          true
        );
      } catch {}
    }
  }
}

router.post(
  '/telegram/webhook',
  express.json({
    limit: '128kb'
  }),
  async (req, res) => {
    const expectedSecret =
      String(
        process.env.TELEGRAM_WEBHOOK_SECRET ||
        ''
      ).trim();

    if (!expectedSecret) {
      return res.status(503).json({
        error:
          'TELEGRAM_WEBHOOK_SECRET is not configured'
      });
    }

    const suppliedSecret =
      req.get(
        'X-Telegram-Bot-Api-Secret-Token'
      ) || '';

    if (
      suppliedSecret !== expectedSecret
    ) {
      return res.status(401).json({
        error: 'Invalid secret'
      });
    }

    try {
      await handleTelegramUpdate(
        req.body,
        req.app.locals.db,
        req.app.locals.admin
      );

      return res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        'telegram webhook:',
        error
      );

      return res.status(500).json({
        error:
          'Webhook processing failed'
      });
    }
  }
);

module.exports = router;
module.exports.grantDeposit = grantDeposit;
module.exports.handleTelegramUpdate = handleTelegramUpdate;
