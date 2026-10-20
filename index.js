'use strict';
/**
 * NOQAT Admin Bot — لوحة تحكم احترافية عبر تيليجرام
 * - يتصل بنفس قاعدة Supabase مباشرة
 * - Long polling + إشعارات فورية لطلبات التوثيق الجديدة
 */
require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

let bwip = null;
try { bwip = require('bwip-js'); } catch (_) { console.warn('⚠️ bwip-js غير مثبت: ميزة الباركود معطّلة'); }

// ============================================================
// الإعدادات (تقبل عدة أسماء للمتغيرات)
// ============================================================
const env = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return ''; };

const BOT_TOKEN = env('BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN', 'TOKEN');
const DB_URL = env('DATABASE_URL', 'SUPABASE_DB_URL', 'DB_URL');
const ADMIN_TG_IDS = env('ADMIN_TG_IDS', 'ADMIN_IDS', 'ADMIN_CHAT_ID', 'TELEGRAM_CHAT_ID', 'ADMIN_TELEGRAM_ID', 'CHAT_ID')
  .split(',').map(s => s.trim()).filter(Boolean);
const TZ = process.env.BOT_TZ || 'Africa/Khartoum';

const PAGE = 5;
const MAX_AMOUNT = 1_000_000_000;
const SESSION_TTL = 10 * 60 * 1000;

if (!BOT_TOKEN) { console.error('❌ توكن البوت مفقود (BOT_TOKEN أو TELEGRAM_BOT_TOKEN)'); process.exit(1); }
if (!DB_URL) { console.error('❌ رابط القاعدة مفقود (DATABASE_URL)'); process.exit(1); }
if (ADMIN_TG_IDS.length === 0) console.warn('⚠️ لا يوجد أدمن: عرّف ADMIN_TG_IDS');

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// منفذ مفتوح لـ Render و UptimeRobot
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  statement_timeout: 15000,
});
pool.on('error', e => console.error('❌ DB:', e.message));

// ============================================================
// أدوات التنسيق
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = v => Number(v || 0).toLocaleString('en-US');
const LINE = '━━━━━━━━━━━━━━━';

function fmtDT(d) {
  if (!d) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d)).replace(',', '').replace(/\//g, '-');
}

function bar(value, total, size = 10) {
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const filled = Math.round(pct * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled) + ` ${Math.round(pct * 100)}%`;
}

function maskId(id) {
  const s = String(id || '');
  return s.length > 4 ? '•'.repeat(s.length - 4) + s.slice(-4) : s;
}

const TYPE_LABEL = {
  transfer: '🔁 تحويل',
  admin_credit: '➕ شحن إداري',
  admin_debit: '➖ خصم إداري',
};

const REJECT_REASONS = {
  1: 'الصورة غير واضحة أو مقطوعة',
  2: 'الاسم لا يطابق المستند',
  3: 'الرقم الوطني غير صحيح',
  4: 'المستند غير مقبول أو منتهي',
  5: 'تاريخ الميلاد لا يطابق المستند',
};

// ============================================================
// طبقة تيليجرام
// ============================================================
async function tg(method, payload = {}, retries = 2) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) {
      if (j.error_code === 429 && retries > 0) {
        await sleep(((j.parameters && j.parameters.retry_after) || 1) * 1000 + 200);
        return tg(method, payload, retries - 1);
      }
      if (!/not modified|message to delete not found|query is too old/i.test(j.description || '')) {
        console.error(`❌ ${method}: ${j.description}`);
      }
    }
    return j;
  } catch (e) {
    console.error(`❌ ${method} (network): ${e.message}`);
    return { ok: false, description: e.message };
  }
}

async function tgForm(method, form) {
  try {
    const r = await fetch(`${API}/${method}`, { method: 'POST', body: form });
    const j = await r.json();
    if (!j.ok) console.error(`❌ ${method}: ${j.description}`);
    return j;
  } catch (e) {
    console.error(`❌ ${method} (network): ${e.message}`);
    return { ok: false, description: e.message };
  }
}

const kb = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

const sendText = (chatId, text, markup) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });

async function sendPhotoBuf(chatId, buf, mime, caption, markup, protect = true) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 1000));
  form.append('parse_mode', 'HTML');
  if (protect) form.append('protect_content', 'true'); // يمنع الحفظ وإعادة التوجيه
  if (markup) form.append('reply_markup', JSON.stringify(markup));
  form.append('photo', new Blob([buf], { type: mime || 'image/jpeg' }), 'photo.jpg');
  return tgForm('sendPhoto', form);
}

async function editPhotoBuf(chatId, msgId, buf, mime, caption, markup) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('message_id', String(msgId));
  form.append('media', JSON.stringify({
    type: 'photo', media: 'attach://photo', caption: caption.slice(0, 1000), parse_mode: 'HTML',
  }));
  form.append('reply_markup', JSON.stringify(markup || { inline_keyboard: [] }));
  form.append('photo', new Blob([buf], { type: mime || 'image/jpeg' }), 'photo.jpg');
  return tgForm('editMessageMedia', form);
}

/** يعرض شاشة نصية: يعدّل الرسالة الحالية إن أمكن وإلا يرسل جديدة */
async function render(ctx, text, markup) {
  if (ctx.msgId) {
    if (!ctx.hasPhoto) {
      const r = await tg('editMessageText', {
        chat_id: ctx.chatId, message_id: ctx.msgId, text, parse_mode: 'HTML',
        reply_markup: markup, disable_web_page_preview: true,
      });
      if (r.ok || /not modified/i.test(r.description || '')) return r;
    }
    await tg('deleteMessage', { chat_id: ctx.chatId, message_id: ctx.msgId });
    ctx.msgId = null; ctx.hasPhoto = false;
  }
  return sendText(ctx.chatId, text, markup);
}

/** يعرض شاشة بصورة: يعدّل الصورة الحالية إن أمكن وإلا يرسل جديدة */
async function renderPhoto(ctx, buf, mime, caption, markup) {
  if (ctx.msgId && ctx.hasPhoto) {
    const r = await editPhotoBuf(ctx.chatId, ctx.msgId, buf, mime, caption, markup);
    if (r.ok) return r;
  }
  if (ctx.msgId) {
    await tg('deleteMessage', { chat_id: ctx.chatId, message_id: ctx.msgId });
    ctx.msgId = null;
  }
  return sendPhotoBuf(ctx.chatId, buf, mime, caption, markup);
}

// ============================================================
// الجلسات + الحماية من الإغراق
// ============================================================
const sessions = new Map();
const getSess = chatId => {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.ts > SESSION_TTL) { sessions.delete(chatId); return null; }
  return s || null;
};
const setSess = (chatId, data) => sessions.set(chatId, { ...data, ts: Date.now() });
const clearSess = chatId => sessions.delete(chatId);

const hits = new Map();
function allowed(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter(t => now - t < 10000);
  arr.push(now);
  hits.set(userId, arr);
  return arr.length <= 25;
}

const isAdmin = id => ADMIN_TG_IDS.includes(String(id));

// ============================================================
// قاعدة البيانات
// ============================================================
async function getStats() {
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const dayStart = `(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
  const [u, d, t, today] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_verified)::int AS verified,
              COUNT(*) FILTER (WHERE status <> 'active')::int AS suspended,
              COALESCE(SUM(balance_points),0)::bigint AS balance
       FROM users`),
    q(`SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='rejected')::int AS rejected
       FROM documents`),
    q(`SELECT COUNT(*)::int AS total,
              COALESCE(SUM(fee_points),0)::bigint AS fees,
              COALESCE(SUM(amount_points) FILTER (WHERE type='transfer'),0)::bigint AS volume
       FROM transactions`),
    q(`SELECT (SELECT COUNT(*) FROM users WHERE created_at >= ${dayStart})::int AS new_users,
              (SELECT COUNT(*) FROM transactions WHERE created_at >= ${dayStart})::int AS txs,
              (SELECT COALESCE(SUM(amount_points),0) FROM transactions
                 WHERE type='transfer' AND created_at >= ${dayStart})::bigint AS volume`, [TZ]),
  ]);
  return { u, d, t, today };
}

const pendingIds = async () =>
  (await pool.query(`SELECT id FROM documents WHERE status='pending' ORDER BY created_at ASC`)).rows.map(r => Number(r.id));

async function getDoc(id) {
  const r = await pool.query(
    `SELECT d.id, d.user_id, d.national_id, d.full_name_4, d.status, d.created_at,
            to_char(d.date_of_birth,'DD-MM-YYYY') AS dob_txt,
            date_part('year', age(d.date_of_birth))::int AS age,
            d.image_bytes, d.image_mime,
            u.username, u.member_number, u.full_name,
            (SELECT member_number FROM users x
               WHERE x.national_id = d.national_id AND x.id <> d.user_id AND x.is_verified LIMIT 1) AS dup_member
     FROM documents d JOIN users u ON u.id = d.user_id
     WHERE d.id = $1`, [id]);
  return r.rows[0] || null;
}

async function approveDoc(docId, tgId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT * FROM documents WHERE id=$1 AND status='pending' FOR UPDATE`, [docId]);
    if (!r.rowCount) { await c.query('ROLLBACK'); return { ok: false, msg: 'الطلب غير موجود أو تمت مراجعته' }; }
    const d = r.rows[0];
    await c.query(`UPDATE documents SET status='approved', reviewed_at=NOW() WHERE id=$1`, [docId]);
    await c.query(`UPDATE users SET is_verified=TRUE, national_id=$1, date_of_birth=$2, updated_at=NOW() WHERE id=$3`,
      [d.national_id, d.date_of_birth, d.user_id]);
    await c.query(`INSERT INTO audit_logs (action, target_user_id, metadata) VALUES ('document_approve',$1,$2)`,
      [d.user_id, JSON.stringify({ documentId: docId, via: 'telegram', tg: tgId })]);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) { await c.query('ROLLBACK'); console.error('approve:', e.message); return { ok: false, msg: 'خطأ أثناء القبول' }; }
  finally { c.release(); }
}

async function rejectDoc(docId, reason, tgId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT * FROM documents WHERE id=$1 AND status='pending' FOR UPDATE`, [docId]);
    if (!r.rowCount) { await c.query('ROLLBACK'); return { ok: false, msg: 'الطلب غير موجود أو تمت مراجعته' }; }
    const d = r.rows[0];
    await c.query(`UPDATE documents SET status='rejected', reviewed_at=NOW(), rejection_reason=$1 WHERE id=$2`, [reason, docId]);
    await c.query(`UPDATE users SET is_verified=FALSE, updated_at=NOW() WHERE id=$1`, [d.user_id]);
    await c.query(`INSERT INTO audit_logs (action, target_user_id, metadata) VALUES ('document_reject',$1,$2)`,
      [d.user_id, JSON.stringify({ documentId: docId, reason, via: 'telegram', tg: tgId })]);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) { await c.query('ROLLBACK'); console.error('reject:', e.message); return { ok: false, msg: 'خطأ أثناء الرفض' }; }
  finally { c.release(); }
}

async function findUsers(q, page = 0) {
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, '');
  const member = digits ? `NQ-${digits}` : null;
  const r = await pool.query(
    `SELECT id, full_name, username, member_number, is_verified, status, balance_points
     FROM users
     WHERE ($1::text = '' )
        OR username ILIKE $2 OR full_name ILIKE $2 OR member_number ILIKE $2
        OR ($3::text IS NOT NULL AND member_number = $3)
     ORDER BY id DESC LIMIT $4 OFFSET $5`,
    [q, like, member, PAGE + 1, page * PAGE]);
  return { rows: r.rows.slice(0, PAGE), more: r.rows.length > PAGE };
}

async function getUser(id) {
  const r = await pool.query(
    `SELECT u.*, (SELECT status FROM documents WHERE user_id=u.id) AS doc_status FROM users u WHERE u.id=$1`, [id]);
  return r.rows[0] || null;
}

async function getUserByMember(input) {
  const digits = String(input).replace(/\D/g, '');
  if (!digits) return null;
  const r = await pool.query(`SELECT * FROM users WHERE member_number=$1`, ['NQ-' + digits]);
  return r.rows[0] || null;
}

async function userTx(uid, limit = 3) {
  return (await pool.query(
    `SELECT t.type, t.amount_points, t.fee_points, t.created_at, t.sender_user_id, t.receiver_user_id
     FROM transactions t WHERE t.sender_user_id=$1 OR t.receiver_user_id=$1
     ORDER BY t.created_at DESC LIMIT $2`, [uid, limit])).rows;
}

async function adjustBalance(kind, uid, amount, reason, tgId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`, [uid]);
    if (!r.rowCount) { await c.query('ROLLBACK'); return { ok: false, msg: 'العضو غير موجود' }; }
    const u = r.rows[0];
    const before = Number(u.balance_points);
    if (kind === 'debit' && before < amount) { await c.query('ROLLBACK'); return { ok: false, msg: 'رصيد العضو أقل من المبلغ' }; }
    const delta = kind === 'credit' ? amount : -amount;
    await c.query(`UPDATE users SET balance_points = balance_points + $1, updated_at=NOW() WHERE id=$2`, [delta, uid]);
    const ref = 'TX-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    if (kind === 'credit') {
      await c.query(`INSERT INTO transactions (reference_number,type,amount_points,fee_points,receiver_user_id,description)
                     VALUES ($1,'admin_credit',$2,0,$3,$4)`, [ref, amount, uid, reason || 'شحن من الإدارة']);
    } else {
      await c.query(`INSERT INTO transactions (reference_number,type,amount_points,fee_points,sender_user_id,description)
                     VALUES ($1,'admin_debit',$2,0,$3,$4)`, [ref, amount, uid, reason || 'خصم إداري']);
    }
    await c.query(`INSERT INTO audit_logs (action,target_user_id,metadata) VALUES ($1,$2,$3)`,
      [kind, uid, JSON.stringify({ amount, reason, via: 'telegram', tg: tgId })]);
    await c.query('COMMIT');
    return { ok: true, ref, before, after: before + delta, user: u };
  } catch (e) { await c.query('ROLLBACK'); console.error('adjust:', e.message); return { ok: false, msg: 'خطأ أثناء تنفيذ العملية' }; }
  finally { c.release(); }
}

async function setStatus(uid, status, tgId) {
  const r = await pool.query(`UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2 AND is_admin=FALSE RETURNING id`, [status, uid]);
  if (!r.rowCount) return false;
  await pool.query(`INSERT INTO audit_logs (action,target_user_id,metadata) VALUES ($1,$2,$3)`,
    [status === 'suspended' ? 'suspend' : 'reactivate', uid, JSON.stringify({ via: 'telegram', tg: tgId })]);
  return true;
}

async function unverifyUser(uid, tgId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE users SET is_verified=FALSE, national_id=NULL, date_of_birth=NULL, updated_at=NOW() WHERE id=$1`, [uid]);
    await c.query(`DELETE FROM documents WHERE user_id=$1`, [uid]);
    await c.query(`INSERT INTO audit_logs (action,target_user_id,metadata) VALUES ('admin_unverify',$1,$2)`,
      [uid, JSON.stringify({ via: 'telegram', tg: tgId })]);
    await c.query('COMMIT');
    return true;
  } catch (e) { await c.query('ROLLBACK'); console.error('unverify:', e.message); return false; }
  finally { c.release(); }
}

async function deleteUser(uid, tgId) {
  try {
    const r = await pool.query(`DELETE FROM users WHERE id=$1 AND is_admin=FALSE RETURNING id`, [uid]);
    if (!r.rowCount) return { ok: false, msg: 'لا يمكن حذف هذا الحساب (مشرف أو غير موجود)' };
    await pool.query(`INSERT INTO audit_logs (action,target_user_id,metadata) VALUES ('delete',NULL,$1)`,
      [JSON.stringify({ deletedUserId: uid, via: 'telegram', tg: tgId })]);
    return { ok: true };
  } catch (e) {
    if (e.code === '23503') return { ok: false, msg: 'لا يمكن حذف عضو لديه معاملات. استخدم التجميد بدلاً من ذلك.' };
    console.error('delete:', e.message);
    return { ok: false, msg: 'خطأ أثناء الحذف' };
  }
}

// ============================================================
// الباركود
// ============================================================
async function sendBarcode(chatId, member, name) {
  if (!bwip) return sendText(chatId, '⚠️ ميزة الباركود غير مفعّلة (ثبّت الحزمة bwip-js).', kb([[btn('🏠 الرئيسية', 'm:home')]]));
  try {
    const code128 = await bwip.toBuffer({ bcid: 'code128', text: member, scale: 3, height: 14, includetext: true, textxalign: 'center', paddingwidth: 12, paddingheight: 8, backgroundcolor: 'FFFFFF' });
    const qr = await bwip.toBuffer({ bcid: 'qrcode', text: member, scale: 6, paddingwidth: 10, paddingheight: 10, backgroundcolor: 'FFFFFF' });
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('protect_content', 'true');
    form.append('media', JSON.stringify([
      { type: 'photo', media: 'attach://p1', caption: `🔳 <b>بطاقة العضوية</b>\n👤 ${esc(name)}\n🆔 <code>${esc(member)}</code>`, parse_mode: 'HTML' },
      { type: 'photo', media: 'attach://p2' },
    ]));
    form.append('p1', new Blob([code128], { type: 'image/png' }), 'barcode.png');
    form.append('p2', new Blob([qr], { type: 'image/png' }), 'qr.png');
    const r = await tgForm('sendMediaGroup', form);
    if (!r.ok) throw new Error(r.description);
  } catch (e) {
    console.error('barcode:', e.message);
    return sendText(chatId, '⚠️ تعذر إنشاء الباركود.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
  }
  return sendText(chatId, '✅ تم إنشاء الباركود (Code128 + QR).', kb([[btn('🔳 باركود آخر', 'b:ask'), btn('🏠 الرئيسية', 'm:home')]]));
}

// ============================================================
// الشاشات
// ============================================================
async function showHome(ctx) {
  const { u, d, t } = await getStats();
  const text =
    `🏦 <b>لوحة تحكم نقاط</b>\n${LINE}\n` +
    `👥 الأعضاء: <b>${num(u.total)}</b>   ✅ موثّقون: <b>${num(u.verified)}</b>\n` +
    `📋 طلبات معلقة: <b>${num(d.pending)}</b>\n` +
    `💸 العمليات: <b>${num(t.total)}</b>\n` +
    `${LINE}\nاختر من القائمة 👇`;
  const pend = d.pending > 0 ? `📋 طلبات التوثيق (${d.pending}) 🔴` : '📋 طلبات التوثيق';
  return render(ctx, text, kb([
    [btn(pend, 'd:v:0')],
    [btn('👥 الأعضاء', 'u:l:0'), btn('🔎 بحث', 'u:s')],
    [btn('➕ شحن', 'a:c:0'), btn('➖ خصم', 'a:d:0')],
    [btn('💸 المعاملات', 't:p:0:0'), btn('📊 الإحصائيات', 'm:stats')],
    [btn('🔳 باركود عضو', 'b:ask'), btn('🧾 سجل التدقيق', 'm:audit:0')],
    [btn('❓ المساعدة', 'm:help')],
  ]));
}

async function showStats(ctx) {
  const { u, d, t, today } = await getStats();
  const text =
    `📊 <b>الإحصائيات</b>\n${LINE}\n` +
    `<b>👥 الأعضاء</b>\n` +
    `• الإجمالي: ${num(u.total)}\n` +
    `• موثّقون: ${num(u.verified)}\n  ${bar(u.verified, u.total)}\n` +
    `• مجمّدون: ${num(u.suspended)}\n\n` +
    `<b>📋 التوثيق</b>\n• معلقة: ${num(d.pending)}   • مرفوضة: ${num(d.rejected)}\n\n` +
    `<b>💰 النقاط</b>\n• إجمالي الأرصدة: ${num(u.balance)}\n• حجم التحويلات: ${num(t.volume)}\n• الرسوم المحصّلة: ${num(t.fees)}\n\n` +
    `<b>📅 اليوم</b>\n• أعضاء جدد: ${num(today.new_users)}\n• عمليات: ${num(today.txs)}\n• حجم التحويل: ${num(today.volume)}`;
  return render(ctx, text, kb([[btn('🔄 تحديث', 'm:stats'), btn('🏠 الرئيسية', 'm:home')]]));
}

async function showHelp(ctx) {
  const text =
    `❓ <b>المساعدة</b>\n${LINE}\n` +
    `• أرسل <b>رقم عضوية</b> أو <b>اسماً</b> في أي وقت للبحث السريع.\n` +
    `• طلبات التوثيق: تصفّح، قبول، أو رفض مع سبب جاهز.\n` +
    `• من بطاقة العضو: شحن، خصم، تجميد، باركود، المعاملات.\n` +
    `• صور الهويات محمية من الحفظ وإعادة التوجيه.\n` +
    `• كل العمليات الإدارية تُسجَّل في سجل التدقيق.\n\n` +
    `<b>الأوامر:</b> /start /pending /members /stats /cancel`;
  return render(ctx, text, kb([[btn('🏠 الرئيسية', 'm:home')]]));
}

async function showDoc(ctx, idx) {
  const ids = await pendingIds();
  if (!ids.length) {
    return render(ctx, '✅ <b>لا توجد طلبات توثيق معلقة</b>\nأحسنت، كل الطلبات تمت مراجعتها.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
  }
  idx = Math.max(0, Math.min(idx, ids.length - 1));
  const d = await getDoc(ids[idx]);
  if (!d) return showDoc(ctx, 0);

  const warn = d.dup_member ? `\n⚠️ <b>تنبيه:</b> الرقم الوطني مسجّل لعضو موثّق آخر (<code>${esc(d.dup_member)}</code>)\n` : '';
  const caption =
    `📄 <b>طلب توثيق #${d.id}</b>   (${idx + 1}/${ids.length})\n${LINE}\n` +
    `👤 <b>الاسم:</b> ${esc(d.full_name_4)}\n` +
    `🆔 <b>الرقم الوطني:</b> <code>${esc(d.national_id)}</code>\n` +
    `🎂 <b>الميلاد:</b> ${esc(d.dob_txt)}  (${d.age} سنة)\n` +
    `🕒 <b>التقديم:</b> ${fmtDT(d.created_at)}\n${warn}${LINE}\n` +
    `👥 <b>صاحب الحساب</b>\n• @${esc(d.username)}\n• <code>${esc(d.member_number)}</code>\n• الاسم المسجّل: ${esc(d.full_name)}`;

  const nav = [];
  if (idx > 0) nav.push(btn('⬅️ السابق', `d:v:${idx - 1}`));
  nav.push(btn(`${idx + 1}/${ids.length}`, 'm:noop'));
  if (idx < ids.length - 1) nav.push(btn('التالي ➡️', `d:v:${idx + 1}`));

  const markup = kb([
    [btn('✅ قبول', `d:ok:${d.id}`), btn('❌ رفض', `d:no:${d.id}`)],
    nav,
    [btn('👤 بطاقة العضو', `u:v:${d.user_id}`), btn('🏠 الرئيسية', 'm:home')],
  ]);

  if (d.image_bytes && d.image_bytes.length) return renderPhoto(ctx, d.image_bytes, d.image_mime, caption, markup);
  return render(ctx, caption + '\n\n⚠️ <b>لا توجد صورة محفوظة لهذا الطلب</b>', markup);
}

async function showUser(ctx, uid, note) {
  const u = await getUser(uid);
  if (!u) return render(ctx, '⚠️ العضو غير موجود.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
  const tx = await userTx(uid, 3);

  const badges = [
    u.is_verified ? '✅ موثّق' : '⛔ غير موثّق',
    u.status === 'active' ? '🟢 نشط' : '🔴 مجمّد',
    u.is_admin ? '👑 مشرف' : null,
    u.doc_status === 'pending' ? '📋 طلب معلق' : null,
  ].filter(Boolean).join('  •  ');

  const txLines = tx.length
    ? tx.map(t => {
        const incoming = Number(t.receiver_user_id) === Number(uid);
        return `${incoming ? '🟢 +' : '🔴 -'}${num(t.amount_points)}  ${TYPE_LABEL[t.type] || t.type}  <i>${fmtDT(t.created_at)}</i>`;
      }).join('\n')
    : 'لا توجد عمليات';

  const text =
    `${note ? note + '\n\n' : ''}👤 <b>${esc(u.full_name)}</b>\n${LINE}\n` +
    `• @${esc(u.username)}\n• <code>${esc(u.member_number)}</code>\n` +
    `• ${badges}\n` +
    `💰 <b>الرصيد:</b> ${num(u.balance_points)} نقطة\n` +
    `📱 الهاتف: ${esc(u.phone || '-')}\n` +
    `🆔 الرقم الوطني: ${u.national_id ? `<code>${esc(maskId(u.national_id))}</code>` : '-'}\n` +
    `📅 الانضمام: ${fmtDT(u.created_at)}\n${LINE}\n` +
    `<b>آخر العمليات</b>\n${txLines}`;

  const rows = [
    [btn('➕ شحن', `a:c:${uid}`), btn('➖ خصم', `a:d:${uid}`)],
    [btn('🔳 باركود', `b:${uid}`), btn('🧾 المعاملات', `t:p:0:${uid}`)],
  ];
  if (!u.is_admin) {
    rows.push([u.status === 'active' ? btn('⏸ تجميد', `s:sus:${uid}`) : btn('▶️ تفعيل', `s:rea:${uid}`)]);
    const danger = [];
    if (u.is_verified) danger.push(btn('🪪 إلغاء التوثيق', `x:unv:${uid}`));
    danger.push(btn('🗑 حذف', `x:del:${uid}`));
    rows.push(danger);
  }
  rows.push([btn('👥 الأعضاء', 'u:l:0'), btn('🏠 الرئيسية', 'm:home')]);
  return render(ctx, text, kb(rows));
}

async function showMembers(ctx, page, q = '') {
  const { rows, more } = await findUsers(q, page);
  const title = q ? `🔎 <b>نتائج البحث:</b> ${esc(q)}` : '👥 <b>الأعضاء</b>';
  if (!rows.length) {
    return render(ctx, `${title}\n${LINE}\nلا توجد نتائج.`, kb([[btn('🔎 بحث جديد', 'u:s'), btn('🏠 الرئيسية', 'm:home')]]));
  }
  const list = rows.map(u => `${u.is_verified ? '✅' : '⛔'}${u.status === 'active' ? '' : '🔴'} <b>${esc(u.full_name)}</b>\n   @${esc(u.username)} • <code>${esc(u.member_number)}</code> • ${num(u.balance_points)}`).join('\n\n');
  const buttons = rows.map(u => [btn(`${u.is_verified ? '✅' : '⛔'} ${u.full_name}`.slice(0, 40), `u:v:${u.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ السابق', `u:l:${page - 1}`));
  if (more) nav.push(btn('التالي ➡️', `u:l:${page + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([btn('🔎 بحث', 'u:s'), btn('🏠 الرئيسية', 'm:home')]);
  return render(ctx, `${title}   (صفحة ${page + 1})\n${LINE}\n${list}`, kb(buttons));
}

async function showTx(ctx, page, uid) {
  const params = [PAGE + 1, page * PAGE];
  let where = '';
  if (uid) { where = 'WHERE t.sender_user_id=$3 OR t.receiver_user_id=$3'; params.push(uid); }
  const r = await pool.query(
    `SELECT t.type, t.amount_points, t.fee_points, t.reference_number, t.created_at, t.description,
            s.full_name AS sender, rc.full_name AS receiver
     FROM transactions t
     LEFT JOIN users s ON s.id=t.sender_user_id
     LEFT JOIN users rc ON rc.id=t.receiver_user_id
     ${where} ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, params);
  const rows = r.rows.slice(0, PAGE);
  const more = r.rows.length > PAGE;
  const back = uid ? btn('👤 العضو', `u:v:${uid}`) : btn('🏠 الرئيسية', 'm:home');
  if (!rows.length) return render(ctx, `💸 <b>المعاملات</b>\n${LINE}\nلا توجد معاملات.`, kb([[back]]));

  const list = rows.map(t =>
    `${TYPE_LABEL[t.type] || t.type}  <b>${num(t.amount_points)}</b>` + (Number(t.fee_points) ? `  (+${t.fee_points} رسوم)` : '') + '\n' +
    `من: ${esc(t.sender || '—')}  ←  إلى: ${esc(t.receiver || '—')}\n` +
    (t.description && t.type !== 'transfer' ? `📝 ${esc(t.description)}\n` : '') +
    `🧾 <code>${esc(t.reference_number)}</code> • ${fmtDT(t.created_at)}`).join('\n\n');
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ الأحدث', `t:p:${page - 1}:${uid || 0}`));
  if (more) nav.push(btn('الأقدم ➡️', `t:p:${page + 1}:${uid || 0}`));
  return render(ctx, `💸 <b>المعاملات</b>   (صفحة ${page + 1})\n${LINE}\n${list}`, kb([...(nav.length ? [nav] : []), [back, btn('🏠', 'm:home')]]));
}

async function showAudit(ctx, page) {
  const r = await pool.query(
    `SELECT a.action, a.metadata, a.created_at, u.username AS target
     FROM audit_logs a LEFT JOIN users u ON u.id=a.target_user_id
     ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [PAGE * 2 + 1, page * PAGE * 2]);
  const rows = r.rows.slice(0, PAGE * 2);
  const more = r.rows.length > PAGE * 2;
  const label = {
    document_approve: '✅ قبول توثيق', document_reject: '❌ رفض توثيق', document_upload: '📤 رفع مستند',
    credit: '➕ شحن', debit: '➖ خصم', suspend: '⏸ تجميد', reactivate: '▶️ تفعيل',
    admin_unverify: '🪪 إلغاء توثيق', delete: '🗑 حذف عضو',
  };
  const list = rows.map(a => {
    const m = a.metadata || {};
    const via = m.via === 'telegram' ? '🤖' : '📱';
    const extra = m.amount ? ` ${num(m.amount)}` : '';
    return `${via} ${label[a.action] || esc(a.action)}${extra}${a.target ? ` • @${esc(a.target)}` : ''}\n   <i>${fmtDT(a.created_at)}</i>`;
  }).join('\n');
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ الأحدث', `m:audit:${page - 1}`));
  if (more) nav.push(btn('الأقدم ➡️', `m:audit:${page + 1}`));
  return render(ctx, `🧾 <b>سجل التدقيق</b>\n${LINE}\n${list || 'لا توجد سجلات.'}`, kb([...(nav.length ? [nav] : []), [btn('🏠 الرئيسية', 'm:home')]]));
}

// ============================================================
// معالج الشحن / الخصم (Wizard)
// ============================================================
const cancelRow = [btn('❌ إلغاء', 'm:cancel')];

async function startAdjust(ctx, kind, uid) {
  const label = kind === 'credit' ? '➕ شحن رصيد' : '➖ خصم رصيد';
  if (uid) {
    const u = await getUser(uid);
    if (!u) return render(ctx, '⚠️ العضو غير موجود.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
    setSess(ctx.chatId, { st: 'adj_amount', kind, uid });
    return render(ctx, `${label}\n${LINE}\n👤 ${esc(u.full_name)}  •  <code>${esc(u.member_number)}</code>\n💰 الرصيد الحالي: <b>${num(u.balance_points)}</b>\n\nأرسل <b>المبلغ</b> (رقم صحيح):`, kb([cancelRow]));
  }
  setSess(ctx.chatId, { st: 'adj_member', kind });
  return render(ctx, `${label}\n${LINE}\nأرسل <b>رقم عضوية</b> العضو (مثال: <code>NQ-12345678</code> أو الأرقام فقط):`, kb([cancelRow]));
}

async function askReason(ctx, s) {
  const u = await getUser(s.uid);
  setSess(ctx.chatId, { ...s, st: 'adj_reason' });
  return render(ctx, `📝 <b>سبب العملية</b>\n${LINE}\n👤 ${esc(u.full_name)}\nالمبلغ: <b>${num(s.amount)}</b>\n\nأرسل السبب أو اضغط تخطي:`,
    kb([[btn('⏭ تخطي', 'a:skip')], cancelRow]));
}

async function confirmAdjust(ctx, s) {
  const u = await getUser(s.uid);
  const after = Number(u.balance_points) + (s.kind === 'credit' ? s.amount : -s.amount);
  setSess(ctx.chatId, { ...s, st: 'adj_confirm' });
  return render(ctx,
    `⚠️ <b>تأكيد ${s.kind === 'credit' ? 'الشحن' : 'الخصم'}</b>\n${LINE}\n` +
    `👤 ${esc(u.full_name)}  •  <code>${esc(u.member_number)}</code>\n` +
    `💰 قبل: ${num(u.balance_points)}\n` +
    `${s.kind === 'credit' ? '➕' : '➖'} المبلغ: <b>${num(s.amount)}</b>\n` +
    `💰 بعد: <b>${num(after)}</b>\n` +
    `📝 السبب: ${esc(s.reason || '—')}`,
    kb([[btn('✅ تأكيد التنفيذ', 'a:go')], cancelRow]));
}

// ============================================================
// معالجة الرسائل النصية
// ============================================================
async function onText(ctx, text, from) {
  const s = getSess(ctx.chatId);
  const t = text.trim();

  if (s) {
    if (s.st === 'reject_reason') {
      clearSess(ctx.chatId);
      if (t.length < 3 || t.length > 200) return sendText(ctx.chatId, '⚠️ السبب يجب أن يكون بين 3 و200 حرف. أعد المحاولة من الطلب.', kb([[btn('📋 الطلبات', 'd:v:0')]]));
      const res = await rejectDoc(s.docId, t, from.id);
      return sendText(ctx.chatId, res.ok ? `❌ تم رفض الطلب #${s.docId}\n📝 ${esc(t)}` : `⚠️ ${esc(res.msg)}`, kb([[btn('➡️ الطلب التالي', 'd:v:0'), btn('🏠', 'm:home')]]));
    }
    if (s.st === 'search') {
      clearSess(ctx.chatId);
      setSess(ctx.chatId, { st: 'idle', q: t });
      return showMembers(ctx, 0, t);
    }
    if (s.st === 'adj_member') {
      const u = await getUserByMember(t);
      if (!u) return sendText(ctx.chatId, '⚠️ لا يوجد عضو بهذا الرقم. أعد الإرسال:', kb([cancelRow]));
      return startAdjust(ctx, s.kind, Number(u.id));
    }
    if (s.st === 'adj_amount') {
      const n = Number(t.replace(/[,\s]/g, ''));
      if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT) return sendText(ctx.chatId, `⚠️ أدخل رقماً صحيحاً بين 1 و ${num(MAX_AMOUNT)}:`, kb([cancelRow]));
      return askReason(ctx, { ...s, amount: n });
    }
    if (s.st === 'adj_reason') {
      return confirmAdjust(ctx, { ...s, reason: t.slice(0, 200) });
    }
    if (s.st === 'bc_member') {
      clearSess(ctx.chatId);
      const u = await getUserByMember(t);
      if (!u) return sendText(ctx.chatId, '⚠️ لا يوجد عضو بهذا الرقم.', kb([[btn('🔳 حاول مجدداً', 'b:ask'), btn('🏠', 'm:home')]]));
      return sendBarcode(ctx.chatId, u.member_number, u.full_name);
    }
  }

  // بحث ذكي: أي نص خارج المعالجات
  if (t.length < 2) return showHome(ctx);
  const digits = t.replace(/\D/g, '');
  if (/^(nq-?)?\d{6,}$/i.test(t.replace(/\s/g, '')) && digits) {
    const u = await getUserByMember(digits);
    if (u) return showUser(ctx, Number(u.id));
  }
  return showMembers(ctx, 0, t.slice(0, 60));
}

// ============================================================
// معالجة الأزرار
// ============================================================
async function onCallback(ctx, data, from) {
  const p = data.split(':');
  const id = n => parseInt(p[n], 10);

  switch (p[0]) {
    case 'm':
      if (p[1] === 'home') { clearSess(ctx.chatId); return showHome(ctx); }
      if (p[1] === 'cancel') { clearSess(ctx.chatId); return showHome(ctx); }
      if (p[1] === 'stats') return showStats(ctx);
      if (p[1] === 'help') return showHelp(ctx);
      if (p[1] === 'audit') return showAudit(ctx, Math.max(0, id(2) || 0));
      return;

    case 'd': {
      if (p[1] === 'v') return showDoc(ctx, Math.max(0, id(2) || 0));
      const docId = id(2);
      if (!Number.isFinite(docId)) return;
      if (p[1] === 'ok') {
        const d = await getDoc(docId);
        if (!d || d.status !== 'pending') return render(ctx, '⚠️ الطلب تمت مراجعته مسبقاً.', kb([[btn('📋 الطلبات', 'd:v:0')]]));
        const dup = d.dup_member ? `\n⚠️ الرقم الوطني مسجّل لعضو آخر: <code>${esc(d.dup_member)}</code>` : '';
        return render(ctx,
          `✅ <b>تأكيد التوثيق</b>\n${LINE}\n👤 ${esc(d.full_name_4)}\n🆔 <code>${esc(d.national_id)}</code>\n🎂 ${esc(d.dob_txt)}\n@${esc(d.username)} • <code>${esc(d.member_number)}</code>${dup}\n\nهل راجعت الصورة وتطابقت البيانات؟`,
          kb([[btn('✅ نعم، وثّق الحساب', `d:go:${docId}`)], [btn('↩️ رجوع للطلب', 'd:v:0')]]));
      }
      if (p[1] === 'go') {
        const res = await approveDoc(docId, from.id);
        return render(ctx, res.ok ? `✅ <b>تم توثيق الحساب</b> (الطلب #${docId})` : `⚠️ ${esc(res.msg)}`, kb([[btn('➡️ الطلب التالي', 'd:v:0'), btn('🏠', 'm:home')]]));
      }
      if (p[1] === 'no') {
        const rows = Object.entries(REJECT_REASONS).map(([k, v]) => [btn(v, `d:r:${docId}:${k}`)]);
        rows.push([btn('✍️ سبب آخر', `d:rc:${docId}`)]);
        rows.push([btn('↩️ رجوع للطلب', 'd:v:0')]);
        return render(ctx, `❌ <b>رفض الطلب #${docId}</b>\n${LINE}\nاختر سبب الرفض:`, kb(rows));
      }
      if (p[1] === 'r') {
        const reason = REJECT_REASONS[id(3)];
        if (!reason) return;
        const res = await rejectDoc(docId, reason, from.id);
        return render(ctx, res.ok ? `❌ <b>تم رفض الطلب #${docId}</b>\n📝 ${esc(reason)}` : `⚠️ ${esc(res.msg)}`, kb([[btn('➡️ الطلب التالي', 'd:v:0'), btn('🏠', 'm:home')]]));
      }
      if (p[1] === 'rc') {
        setSess(ctx.chatId, { st: 'reject_reason', docId });
        return render(ctx, `✍️ أرسل <b>سبب الرفض</b> للطلب #${docId} في رسالة واحدة (3–200 حرف):`, kb([cancelRow]));
      }
      return;
    }

    case 'u':
      if (p[1] === 'l') {
        const s = getSess(ctx.chatId);
        const page = Math.max(0, id(2) || 0);
        return showMembers(ctx, page, s && s.q ? s.q : '');
      }
      if (p[1] === 's') {
        setSess(ctx.chatId, { st: 'search' });
        return render(ctx, `🔎 <b>بحث عن عضو</b>\n${LINE}\nأرسل الاسم أو اسم المستخدم أو رقم العضوية:`, kb([cancelRow]));
      }
      if (p[1] === 'v') return showUser(ctx, id(2));
      return;

    case 's': {
      const uid = id(2);
      const ok = await setStatus(uid, p[1] === 'sus' ? 'suspended' : 'active', from.id);
      return showUser(ctx, uid, ok ? (p[1] === 'sus' ? '⏸ تم تجميد الحساب' : '▶️ تم تفعيل الحساب') : '⚠️ لا يمكن تعديل حالة هذا الحساب');
    }

    case 'x': { // تأكيد عمليات خطرة
      const uid = id(2);
      const u = await getUser(uid);
      if (!u) return showHome(ctx);
      const what = p[1] === 'del' ? '🗑 <b>حذف العضو نهائياً</b>' : '🪪 <b>إلغاء توثيق العضو</b> (يُحذف مستنده)';
      return render(ctx, `⚠️ ${what}\n${LINE}\n👤 ${esc(u.full_name)}  •  <code>${esc(u.member_number)}</code>\n\nهذا الإجراء لا يمكن التراجع عنه. متأكد؟`,
        kb([[btn('✅ نعم، نفّذ', `y:${p[1]}:${uid}`)], [btn('↩️ إلغاء', `u:v:${uid}`)]]));
    }

    case 'y': {
      const uid = id(2);
      if (p[1] === 'unv') {
        const ok = await unverifyUser(uid, from.id);
        return showUser(ctx, uid, ok ? '🪪 تم إلغاء التوثيق' : '⚠️ فشل إلغاء التوثيق');
      }
      if (p[1] === 'del') {
        const res = await deleteUser(uid, from.id);
        if (!res.ok) return showUser(ctx, uid, `⚠️ ${esc(res.msg)}`);
        return render(ctx, '🗑 تم حذف العضو.', kb([[btn('👥 الأعضاء', 'u:l:0'), btn('🏠', 'm:home')]]));
      }
      return;
    }

    case 'a': {
      if (p[1] === 'c' || p[1] === 'd') return startAdjust(ctx, p[1] === 'c' ? 'credit' : 'debit', id(2) || 0);
      const s = getSess(ctx.chatId);
      if (p[1] === 'skip') {
        if (!s || s.st !== 'adj_reason') return showHome(ctx);
        return confirmAdjust(ctx, { ...s, reason: '' });
      }
      if (p[1] === 'go') {
        if (!s || s.st !== 'adj_confirm') return render(ctx, '⌛ انتهت الجلسة. ابدأ من جديد.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
        clearSess(ctx.chatId);
        const res = await adjustBalance(s.kind, s.uid, s.amount, s.reason, from.id);
        if (!res.ok) return render(ctx, `⚠️ ${esc(res.msg)}`, kb([[btn('🏠 الرئيسية', 'm:home')]]));
        return render(ctx,
          `✅ <b>تمت العملية بنجاح</b>\n${LINE}\n👤 ${esc(res.user.full_name)}\n${s.kind === 'credit' ? '➕' : '➖'} ${num(s.amount)}\n💰 الرصيد الجديد: <b>${num(res.after)}</b>\n🧾 <code>${res.ref}</code>`,
          kb([[btn('👤 بطاقة العضو', `u:v:${s.uid}`), btn('🏠', 'm:home')]]));
      }
      return;
    }

    case 't':
      return showTx(ctx, Math.max(0, id(2) || 0), id(3) || 0);

    case 'b':
      if (p[1] === 'ask') {
        setSess(ctx.chatId, { st: 'bc_member' });
        return render(ctx, `🔳 <b>باركود العضوية</b>\n${LINE}\nأرسل <b>رقم العضوية</b> لإنشاء الباركود و QR:`, kb([cancelRow]));
      } else {
        const u = await getUser(id(1));
        if (!u) return showHome(ctx);
        return sendBarcode(ctx.chatId, u.member_number, u.full_name);
      }
  }
}

// ============================================================
// نقطة الدخول للتحديثات
// ============================================================
async function handleUpdate(u) {
  const msg = u.message;
  const cb = u.callback_query;
  const from = (msg || cb || {}).from;
  if (!from) return;
  const chatId = msg ? msg.chat.id : cb.message.chat.id;

  if (!isAdmin(from.id)) {
    console.warn(`⛔ وصول مرفوض من ${from.id}`);
    if (cb) await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'غير مصرّح', show_alert: true });
    else if (msg.chat.type === 'private') {
      await sendText(chatId, `⛔ <b>غير مصرّح</b>\nهذا البوت مخصص للإدارة.\n\nمعرّفك: <code>${from.id}</code>\n<i>أضفه إلى ADMIN_TG_IDS ليتم السماح لك.</i>`);
    }
    return;
  }
  if (!allowed(from.id)) {
    if (cb) await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'مهلاً، عمليات كثيرة ⏳' });
    return;
  }

  try {
    if (cb) {
      const ctx = { chatId, userId: from.id, msgId: cb.message.message_id, hasPhoto: !!cb.message.photo };
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      if (cb.data === 'm:noop') return;
      await onCallback(ctx, cb.data || '', from);
    } else if (msg.text) {
      const ctx = { chatId, userId: from.id, msgId: null, hasPhoto: false };
      const text = msg.text;
      if (text.startsWith('/')) {
        const cmd = text.split(/[\s@]/)[0].toLowerCase();
        clearSess(chatId);
        if (cmd === '/start' || cmd === '/menu' || cmd === '/cancel') return showHome(ctx);
        if (cmd === '/pending') return showDoc(ctx, 0);
        if (cmd === '/members') return showMembers(ctx, 0, '');
        if (cmd === '/stats') return showStats(ctx);
        if (cmd === '/help') return showHelp(ctx);
        return showHome(ctx);
      }
      await onText(ctx, text, from);
    }
  } catch (e) {
    console.error('❌ handler:', e.message);
    await sendText(chatId, '⚠️ حدث خطأ غير متوقع. حاول مجدداً.', kb([[btn('🏠 الرئيسية', 'm:home')]]));
  }
}

// ============================================================
// إشعارات فورية بطلبات التوثيق الجديدة
// ============================================================
let lastSeen = null;
async function notifyNewDocs() {
  try {
    if (!lastSeen) {
      const r = await pool.query(`SELECT COALESCE(MAX(created_at), NOW()) AS m FROM documents`);
      lastSeen = r.rows[0].m;
      return;
    }
    const r = await pool.query(
      `SELECT id, created_at FROM documents WHERE status='pending' AND created_at > $1 ORDER BY created_at ASC`, [lastSeen]);
    for (const row of r.rows) {
      lastSeen = row.created_at;
      const d = await getDoc(row.id);
      if (!d) continue;
      const caption =
        `🔔 <b>طلب توثيق جديد #${d.id}</b>\n${LINE}\n` +
        `👤 ${esc(d.full_name_4)}\n🆔 <code>${esc(d.national_id)}</code>\n🎂 ${esc(d.dob_txt)}\n` +
        `@${esc(d.username)} • <code>${esc(d.member_number)}</code>` +
        (d.dup_member ? `\n⚠️ الرقم الوطني مسجّل لعضو آخر` : '');
      const markup = kb([[btn('📋 فتح الطلب', `d:v:0`), btn('🏠', 'm:home')]]);
      for (const adminId of ADMIN_TG_IDS) {
        if (d.image_bytes && d.image_bytes.length) await sendPhotoBuf(adminId, d.image_bytes, d.image_mime, caption, markup);
        else await sendText(adminId, caption, markup);
      }
    }
  } catch (e) { console.error('notify:', e.message); }
}

// ============================================================
// التشغيل
// ============================================================
let running = true;
async function main() {
  await pool.query('SELECT 1');
  console.log('✅ قاعدة البيانات متصلة');
  await tg('deleteWebhook', { drop_pending_updates: false });
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'القائمة الرئيسية' },
      { command: 'pending', description: 'طلبات التوثيق' },
      { command: 'members', description: 'الأعضاء' },
      { command: 'stats', description: 'الإحصائيات' },
      { command: 'help', description: 'المساعدة' },
      { command: 'cancel', description: 'إلغاء العملية الحالية' },
    ],
  });
  console.log(`🤖 البوت يعمل. عدد الأدمن: ${ADMIN_TG_IDS.length}`);

  await notifyNewDocs();
  setInterval(notifyNewDocs, 20000);
  setInterval(() => { // تنظيف الجلسات المنتهية
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.ts > SESSION_TTL) sessions.delete(k);
  }, 60000);

  let offset = 0;
  while (running) {
    try {
      const r = await fetch(`${API}/getUpdates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }),
      });
      const j = await r.json();
      if (!j.ok) {
        console.error('❌ getUpdates:', j.description);
        await sleep(j.error_code === 409 ? 15000 : 5000);
        continue;
      }
      for (const u of j.result) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch(e => console.error('❌ update:', e.message));
      }
    } catch (e) {
      console.error('❌ polling:', e.message);
      await sleep(5000);
    }
  }
}

const shutdown = async () => { running = false; try { await pool.end(); } catch (_) {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('❌ unhandledRejection:', e && e.message));

main().catch(e => { console.error('❌ فشل التشغيل:', e.message); process.exit(1); });
