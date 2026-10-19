require('dotenv').config();
const { Pool } = require('pg');

// ---------- الإعدادات ----------
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TG_IDS = (process.env.ADMIN_TG_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN مفقود');
  process.exit(1);
}
if (ADMIN_TG_IDS.length === 0) {
  console.warn('⚠️ ADMIN_TG_IDS فارغ: لن يُسمح لأي أحد باستخدام البوت');
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});
pool.on('error', e => console.error('❌ DB error:', e.message));

// ---------- أدوات تيليجرام ----------
async function tg(method, payload = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) console.error(`❌ ${method}:`, j.description);
  return j;
}

async function sendPhoto(chatId, buffer, mime, caption, replyMarkup) {
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 1000));
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([buffer], { type: mime }), `document.${ext}`);

  const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  const j = await r.json();
  if (!j.ok) console.error('❌ sendPhoto:', j.description);
  return j;
}

const send = (chatId, text, replyMarkup) =>
  tg('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });

// ---------- القوائم ----------
const mainMenu = {
  inline_keyboard: [
    [{ text: '📋 طلبات التوثيق', callback_data: 'pending' }],
    [{ text: '📊 الإحصائيات', callback_data: 'stats' }],
    [{ text: '💸 آخر المعاملات', callback_data: 'txs' }]
  ]
};

const homeButton = {
  inline_keyboard: [[{ text: '🏠 القائمة الرئيسية', callback_data: 'menu' }]]
};

const isAdmin = (id) => ADMIN_TG_IDS.includes(String(id));

function fmtDate(d) {
  if (!d) return '-';
  const x = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${p(x.getDate())}-${p(x.getMonth() + 1)}-${x.getFullYear()}`;
}

// حالة انتظار سبب الرفض: chatId -> docId
const awaitingReason = new Map();

// ---------- الإجراءات ----------
async function showMenu(chatId) {
  await send(chatId, '🏠 القائمة الرئيسية', mainMenu);
}

async function showStats(chatId) {
  const q = async (sql) => (await pool.query(sql)).rows[0].c;
  const users = await q('SELECT COUNT(*) AS c FROM users');
  const verified = await q('SELECT COUNT(*) AS c FROM users WHERE is_verified = TRUE');
  const pending = await q(`SELECT COUNT(*) AS c FROM documents WHERE status = 'pending'`);
  const txs = await q('SELECT COUNT(*) AS c FROM transactions');
  const balance = (await pool.query(
    'SELECT COALESCE(SUM(balance_points), 0) AS s FROM users'
  )).rows[0].s;

  await send(
    chatId,
    `📊 الإحصائيات\n\n` +
    `👥 المستخدمون: ${users}\n` +
    `✅ الموثّقون: ${verified}\n` +
    `📋 طلبات معلقة: ${pending}\n` +
    `💸 المعاملات: ${txs}\n` +
    `💰 إجمالي الرصيد: ${balance}`,
    homeButton
  );
}

async function showTransactions(chatId) {
  const r = await pool.query(
    `SELECT t.reference_number, t.type, t.amount_points, t.fee_points, t.created_at,
            s.full_name AS sender_name, rc.full_name AS receiver_name
     FROM transactions t
     LEFT JOIN users s ON s.id = t.sender_user_id
     LEFT JOIN users rc ON rc.id = t.receiver_user_id
     ORDER BY t.created_at DESC
     LIMIT 10`
  );

  if (r.rowCount === 0) {
    return send(chatId, 'لا توجد معاملات بعد.', homeButton);
  }

  const typeLabel = {
    transfer: '🔁 تحويل',
    admin_credit: '➕ شحن إداري',
    admin_debit: '➖ خصم إداري'
  };

  const lines = r.rows.map(t =>
    `${typeLabel[t.type] || t.type}  ${t.amount_points} نقطة` +
    (Number(t.fee_points) ? ` (رسوم ${t.fee_points})` : '') + '\n' +
    `من: ${t.sender_name || '—'}  ←  إلى: ${t.receiver_name || '—'}\n` +
    `🧾 ${t.reference_number}  •  ${fmtDate(t.created_at)}`
  );

  await send(chatId, `💸 آخر المعاملات\n\n${lines.join('\n\n')}`, homeButton);
}

async function showPending(chatId) {
  const r = await pool.query(
    `SELECT d.id, d.national_id, d.full_name_4, d.date_of_birth, d.created_at,
            d.image_bytes, d.image_mime,
            u.id AS user_id, u.username, u.member_number
     FROM documents d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC`
  );

  if (r.rowCount === 0) {
    return send(chatId, '✅ لا توجد طلبات معلقة.', homeButton);
  }

  await send(chatId, `📋 ${r.rowCount} طلب معلق:`);

  for (const d of r.rows) {
    const caption =
      `📄 طلب توثيق #${d.id}\n\n` +
      `👤 الاسم: ${d.full_name_4}\n` +
      `🆔 الرقم الوطني: ${d.national_id}\n` +
      `🎂 الميلاد: ${fmtDate(d.date_of_birth)}\n` +
      `📅 التقديم: ${fmtDate(d.created_at)}\n\n` +
      `👥 صاحب الحساب:\n` +
      `• @${d.username}\n` +
      `• ${d.member_number}\n` +
      `• ID: ${d.user_id}`;

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ قبول', callback_data: `approve:${d.id}` },
        { text: '❌ رفض', callback_data: `reject:${d.id}` }
      ]]
    };

    if (d.image_bytes && d.image_bytes.length > 0) {
      const res = await sendPhoto(chatId, d.image_bytes, d.image_mime || 'image/jpeg', caption, keyboard);
      if (!res.ok) {
        await send(chatId, caption + '\n\n⚠️ تعذر إرسال الصورة', keyboard);
      }
    } else {
      await send(chatId, caption + '\n\n⚠️ لا توجد صورة محفوظة لهذا الطلب', keyboard);
    }
  }

  await send(chatId, '— انتهى —', homeButton);
}

async function approveDoc(docId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docR = await client.query(
      `SELECT * FROM documents WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [docId]
    );
    if (docR.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, msg: 'الطلب غير موجود أو تمت مراجعته' };
    }
    const doc = docR.rows[0];

    await client.query(
      `UPDATE documents SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
      [docId]
    );
    await client.query(
      `UPDATE users
       SET is_verified = TRUE, national_id = $1, date_of_birth = $2, updated_at = NOW()
       WHERE id = $3`,
      [doc.national_id, doc.date_of_birth, doc.user_id]
    );
    await client.query(
      `INSERT INTO audit_logs (action, target_user_id, metadata)
       VALUES ('document_approve', $1, $2)`,
      [doc.user_id, JSON.stringify({ documentId: docId, via: 'telegram' })]
    );

    await client.query('COMMIT');
    return { ok: true, msg: `✅ تم توثيق الطلب #${docId}` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ approve:', e.message);
    return { ok: false, msg: 'حدث خطأ أثناء القبول' };
  } finally {
    client.release();
  }
}

async function rejectDoc(docId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docR = await client.query(
      `SELECT * FROM documents WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [docId]
    );
    if (docR.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, msg: 'الطلب غير موجود أو تمت مراجعته' };
    }
    const doc = docR.rows[0];

    await client.query(
      `UPDATE documents
       SET status = 'rejected', reviewed_at = NOW(), rejection_reason = $1
       WHERE id = $2`,
      [reason, docId]
    );
    await client.query(
      `UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1`,
      [doc.user_id]
    );
    await client.query(
      `INSERT INTO audit_logs (action, target_user_id, metadata)
       VALUES ('document_reject', $1, $2)`,
      [doc.user_id, JSON.stringify({ documentId: docId, reason, via: 'telegram' })]
    );

    await client.query('COMMIT');
    return { ok: true, msg: `❌ تم رفض الطلب #${docId}\nالسبب: ${reason}` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ reject:', e.message);
    return { ok: false, msg: 'حدث خطأ أثناء الرفض' };
  } finally {
    client.release();
  }
}

// ---------- معالجة التحديثات ----------
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) {
    return send(chatId, '⛔ غير مصرّح لك باستخدام هذا البوت.');
  }

  const text = (msg.text || '').trim();

  // انتظار سبب الرفض
  if (awaitingReason.has(chatId) && text && !text.startsWith('/')) {
    const docId = awaitingReason.get(chatId);
    awaitingReason.delete(chatId);
    const res = await rejectDoc(docId, text);
    return send(chatId, res.msg, homeButton);
  }

  if (text === '/cancel') {
    awaitingReason.delete(chatId);
    return send(chatId, 'تم الإلغاء.', homeButton);
  }

  if (text === '/start' || text === '/menu') {
    awaitingReason.delete(chatId);
    return showMenu(chatId);
  }
  if (text === '/pending') return showPending(chatId);
  if (text === '/stats') return showStats(chatId);

  return showMenu(chatId);
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || '';

  if (!isAdmin(cb.from.id)) {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'غير مصرّح',
      show_alert: true
    });
  }

  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  try {
    if (data === 'menu') return showMenu(chatId);
    if (data === 'pending') return showPending(chatId);
    if (data === 'stats') return showStats(chatId);
    if (data === 'txs') return showTransactions(chatId);

    if (data.startsWith('approve:')) {
      const docId = parseInt(data.split(':')[1], 10);
      const res = await approveDoc(docId);
      // إزالة الأزرار حتى لا تُضغط مرتين
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
      return send(chatId, res.msg);
    }

    if (data.startsWith('reject:')) {
      const docId = parseInt(data.split(':')[1], 10);
      awaitingReason.set(chatId, docId);
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
      return send(
        chatId,
        `✍️ اكتب سبب رفض الطلب #${docId} في رسالة واحدة.\nللإلغاء أرسل /cancel`
      );
    }
  } catch (e) {
    console.error('❌ callback error:', e.message);
    send(chatId, 'حدث خطأ، حاول مرة أخرى.');
  }
}

// ---------- الحلقة الرئيسية (Long Polling) ----------
async function main() {
  // تأكد أن لا يوجد webhook يمنع getUpdates
  await tg('deleteWebhook', { drop_pending_updates: false });

  await pool.query('SELECT 1');
  console.log('✅ Bot DB connected');
  console.log(`🤖 Bot started. Admins: ${ADMIN_TG_IDS.length}`);

  let offset = 0;
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query']
        })
      });
      const j = await r.json();

      if (!j.ok) {
        console.error('❌ getUpdates:', j.description);
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }

      for (const u of j.result) {
        offset = u.update_id + 1;
        try {
          if (u.message) await handleMessage(u.message);
          else if (u.callback_query) await handleCallback(u.callback_query);
        } catch (e) {
          console.error('❌ update error:', e.message);
        }
      }
    } catch (e) {
      console.error('❌ polling error:', e.message);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

process.on('SIGTERM', async () => { try { await pool.end(); } catch (_) {} process.exit(0); });
process.on('SIGINT', async () => { try { await pool.end(); } catch (_) {} process.exit(0); });

main().catch(e => {
  console.error('❌ Bot startup failed:', e.message);
  process.exit(1);
});
