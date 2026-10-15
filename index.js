const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

// =====================================
// إعداد خادم HTTP
// =====================================

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('بوت NOQAT للتوثيق وإهداء النقاط يعمل بنجاح');
});

app.listen(port, () => {
    console.log('HTTP server running on port ' + port);
});

// =====================================
// إعداد قاعدة البيانات
// =====================================

if (!process.env.DATABASE_URL) {
    console.error('خطأ: DATABASE_URL غير موجود في إعدادات البيئة');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ||
         (process.env.DATABASE_URL || '').includes('supabase')
        ? { rejectUnauthorized: false }
        : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
});

pool.on('error', (err) => {
    console.error('خطأ غير متوقع في قاعدة البيانات:', err.message);
});

// =====================================
// إعداد البوت
// =====================================

if (!process.env.BOT_TOKEN) {
    console.error('خطأ: BOT_TOKEN غير موجود في إعدادات البيئة');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');

// حالة المستخدمين
const userState = new Map();

// =====================================
// أدوات مساعدة
// =====================================

function isAdmin(ctx) {
    return String(ctx.from.id) === ADMIN_CHAT_ID;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toISOString().split('T')[0];
}

function formatNumber(n) {
    return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

function getState(ctx) {
    return userState.get(ctx.from.id) || {};
}

function setState(ctx, values) {
    const oldState = getState(ctx);
    userState.set(ctx.from.id, { ...oldState, ...values });
}

function resetState(ctx) {
    userState.set(ctx.from.id, { step: 'main' });
}

async function safeEdit(ctx, text, keyboard) {
    try {
        await ctx.editMessageText(text, keyboard);
    } catch (error) {
        if (
            error.description &&
            error.description.includes('message is not modified')
        ) {
            return;
        }
        await ctx.reply(text, keyboard);
    }
}

// =====================================
// القوائم
// =====================================

function mainKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📋 طلبات التوثيق المعلقة', 'pending_docs')],
        [Markup.button.callback('📊 الإحصائيات', 'stats')],
        [Markup.button.callback('🎁 إهداء نقاط', 'gift_help')]
    ]);
}

function homeKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🏠 القائمة الرئيسية', 'main')]
    ]);
}

async function showMain(ctx, edit) {
    const message =
        '👋 *مرحباً بك في لوحة تحكم NOQAT*\n\n' +
        '🤖 هذا البوت مخصص لإدارة:\n' +
        '• طلبات توثيق المستخدمين\n' +
        '• إهداء النقاط للأعضاء\n' +
        '• متابعة إحصائيات النظام\n\n' +
        'اختر العملية المطلوبة:';

    if (edit) {
        await safeEdit(ctx, message, { parse_mode: 'Markdown', ...mainKeyboard() });
    } else {
        await ctx.reply(message, { parse_mode: 'Markdown', ...mainKeyboard() });
    }
}

// =====================================
// الأوامر
// =====================================

bot.start(async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ هذا البوت مخصص للمشرفين فقط.');
    }
    resetState(ctx);
    await showMain(ctx, false);
});

bot.command('help', async (ctx) => {
    if (!isAdmin(ctx)) return;

    await ctx.reply(
        '📖 *الأوامر المتاحة:*\n\n' +
        '• `/start` — القائمة الرئيسية\n' +
        '• `/gift NQ-12345678 100` — إهداء نقاط\n' +
        '• `/stats` — الإحصائيات',
        { parse_mode: 'Markdown' }
    );
});

bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await showStats(ctx);
});

bot.command('gift', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply(
            '⚠️ *الصيغة الصحيحة:*\n' +
            '`/gift NQ-12345678 100`',
            { parse_mode: 'Markdown' }
        );
    }

    await handleGift(ctx, parts[1], parts[2]);
});

bot.action('main', async (ctx) => {
    await ctx.answerCbQuery();
    resetState(ctx);
    await showMain(ctx, true);
});

// =====================================
// طلبات التوثيق المعلقة
// =====================================

bot.action('pending_docs', async (ctx) => {
    await ctx.answerCbQuery();
    await showPendingDocuments(ctx);
});

async function showPendingDocuments(ctx) {
    try {
        const r = await pool.query(
            `SELECT d.id, d.national_id, d.full_name_4, d.date_of_birth,
                    d.image_data, d.created_at,
                    u.username, u.member_number, u.full_name
             FROM documents d
             JOIN users u ON u.id = d.user_id
             WHERE d.status = 'pending'
             ORDER BY d.created_at ASC
             LIMIT 10`
        );

        if (r.rowCount === 0) {
            return ctx.reply(
                '✅ لا توجد طلبات توثيق معلقة حالياً.',
                homeKeyboard()
            );
        }

        await ctx.reply(
            `📋 *يوجد ${r.rowCount} طلب توثيق معلق:*`,
            { parse_mode: 'Markdown' }
        );

        for (const doc of r.rows) {
            const caption =
                `👤 *الاسم:* ${doc.full_name_4}\n` +
                `🆔 *الرقم الوطني:* \`${doc.national_id}\`\n` +
                `🎂 *تاريخ الميلاد:* ${formatDate(doc.date_of_birth)}\n` +
                `📅 *تاريخ التقديم:* ${formatDate(doc.created_at)}\n\n` +
                `👥 *صاحب الحساب:*\n` +
                `• الاسم: ${doc.full_name}\n` +
                `• اسم المستخدم: @${doc.username}\n` +
                `• رقم العضوية: \`${doc.member_number}\``;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ قبول', `approve_doc_${doc.id}`),
                    Markup.button.callback('❌ رفض', `reject_doc_${doc.id}`)
                ]
            ]);

            try {
                const base64Data = (doc.image_data || '')
                    .replace(/^data:image\/\w+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');

                await ctx.replyWithPhoto(
                    { source: imageBuffer },
                    {
                        caption: caption,
                        parse_mode: 'Markdown',
                        ...keyboard
                    }
                );
            } catch (err) {
                await ctx.reply(caption, {
                    parse_mode: 'Markdown',
                    ...keyboard
                });
            }
        }

        await ctx.reply('— انتهى العرض —', homeKeyboard());
    } catch (e) {
        console.error('خطأ في جلب الطلبات:', e.message);
        await ctx.reply('❌ حدث خطأ أثناء جلب الطلبات.');
    }
}

// =====================================
// قبول التوثيق
// =====================================

bot.action(/^approve_doc_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const docId = Number(ctx.match[1]);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const docR = await client.query(
            'SELECT * FROM documents WHERE id = $1 AND status = $2 FOR UPDATE',
            [docId, 'pending']
        );

        if (docR.rowCount === 0) {
            await client.query('ROLLBACK');
            return ctx.reply('⚠️ المستند غير موجود أو تمت مراجعته مسبقاً.');
        }

        const doc = docR.rows[0];

        await client.query(
            'UPDATE documents SET status = $1, reviewed_at = NOW() WHERE id = $2',
            ['approved', docId]
        );

        await client.query(
            `UPDATE users
             SET is_verified = TRUE, national_id = $1, date_of_birth = $2, updated_at = NOW()
             WHERE id = $3`,
            [doc.national_id, doc.date_of_birth, doc.user_id]
        );

        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, 'bot_document_approve', $1, $2)`,
            [doc.user_id, JSON.stringify({ documentId: docId, via: 'telegram_bot' })]
        );

        await client.query('COMMIT');

        await ctx.editMessageCaption(
            `✅ *تم قبول التوثيق*\n\n` +
            `👤 ${doc.full_name_4}\n` +
            `🆔 \`${doc.national_id}\``,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        await ctx.reply('✅ تم توثيق الحساب بنجاح.', homeKeyboard());
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('خطأ في القبول:', e.message);
        await ctx.reply('❌ حدث خطأ أثناء القبول.');
    } finally {
        client.release();
    }
});

// =====================================
// رفض التوثيق
// =====================================

bot.action(/^reject_doc_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const docId = Number(ctx.match[1]);

    setState(ctx, { step: 'reject_reason', rejectDocId: docId });

    await ctx.reply(
        `✍️ أرسل الآن سبب رفض المستند رقم \`${docId}\` في رسالة نصية.`,
        { parse_mode: 'Markdown' }
    );
});

async function handleRejectReason(ctx, docId, reason) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const docR = await client.query(
            'SELECT * FROM documents WHERE id = $1 AND status = $2 FOR UPDATE',
            [docId, 'pending']
        );

        if (docR.rowCount === 0) {
            await client.query('ROLLBACK');
            return ctx.reply('⚠️ المستند غير موجود أو تمت مراجعته مسبقاً.');
        }

        const doc = docR.rows[0];

        await client.query(
            `UPDATE documents
             SET status = $1, reviewed_at = NOW(), rejection_reason = $2
             WHERE id = $3`,
            ['rejected', reason, docId]
        );

        await client.query(
            'UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1',
            [doc.user_id]
        );

        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, 'bot_document_reject', $1, $2)`,
            [doc.user_id, JSON.stringify({ documentId: docId, reason, via: 'telegram_bot' })]
        );

        await client.query('COMMIT');

        await ctx.reply(
            `❌ *تم رفض التوثيق*\n\n` +
            `👤 ${doc.full_name_4}\n` +
            `📝 *السبب:* ${reason}`,
            { parse_mode: 'Markdown', ...homeKeyboard() }
        );
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('خطأ في الرفض:', e.message);
        await ctx.reply('❌ حدث خطأ أثناء الرفض.');
    } finally {
        client.release();
    }
}

// =====================================
// إهداء النقاط
// =====================================

bot.action('gift_help', async (ctx) => {
    await ctx.answerCbQuery();

    await safeEdit(
        ctx,
        '🎁 *إهداء النقاط*\n\n' +
        'استخدم الأمر التالي:\n' +
        '`/gift NQ-12345678 100`\n\n' +
        'حيث:\n' +
        '• `NQ-12345678` رقم العضوية\n' +
        '• `100` عدد النقاط',
        { parse_mode: 'Markdown', ...homeKeyboard() }
    );
});

async function handleGift(ctx, memberNumberRaw, amountRaw) {
    const amount = parseInt(amountRaw, 10);

    if (!Number.isInteger(amount) || amount <= 0) {
        return ctx.reply('❌ المبلغ غير صحيح. يجب أن يكون رقماً صحيحاً موجباً.');
    }

    let normalized = String(memberNumberRaw).trim().toUpperCase();
    if (normalized.startsWith('NQ-')) normalized = normalized.substring(3);
    normalized = normalized.replace(/[^0-9]/g, '');

    if (!normalized) {
        return ctx.reply('❌ رقم العضوية غير صالح.');
    }

    const memberNumber = 'NQ-' + normalized;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const uR = await client.query(
            'SELECT * FROM users WHERE member_number = $1 FOR UPDATE',
            [memberNumber]
        );

        if (uR.rowCount === 0) {
            await client.query('ROLLBACK');
            return ctx.reply(
                `❌ لا يوجد مستخدم برقم العضوية: \`${memberNumber}\``,
                { parse_mode: 'Markdown' }
            );
        }

        const target = uR.rows[0];

        await client.query(
            'UPDATE users SET balance_points = balance_points + $1, updated_at = NOW() WHERE id = $2',
            [amount, target.id]
        );

        const ref = 'TX-' + Date.now().toString(36).toUpperCase() +
                    Math.random().toString(16).substring(2, 6).toUpperCase();

        await client.query(
            `INSERT INTO transactions
             (reference_number, type, amount_points, fee_points, receiver_user_id, description)
             VALUES ($1, 'admin_gift', $2, 0, $3, $4)`,
            [ref, amount, target.id, 'إهداء من الإدارة']
        );

        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, 'bot_gift_points', $1, $2)`,
            [target.id, JSON.stringify({ amount, via: 'telegram_bot' })]
        );

        await client.query('COMMIT');

        const newBalance = Number(target.balance_points) + amount;

        await ctx.reply(
            `🎁 *تم إهداء النقاط بنجاح*\n\n` +
            `👤 *المستلم:* ${target.full_name}\n` +
            `🔢 *رقم العضوية:* \`${target.member_number}\`\n` +
            `➕ *النقاط المهداة:* ${formatNumber(amount)}\n` +
            `💰 *الرصيد الجديد:* ${formatNumber(newBalance)}\n` +
            `🧾 *رقم العملية:* \`${ref}\``,
            { parse_mode: 'Markdown', ...homeKeyboard() }
        );
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('خطأ في الإهداء:', e.message);
        await ctx.reply('❌ حدث خطأ أثناء إهداء النقاط.');
    } finally {
        client.release();
    }
}

// =====================================
// الإحصائيات
// =====================================

bot.action('stats', async (ctx) => {
    await ctx.answerCbQuery();
    await showStats(ctx);
});

async function showStats(ctx) {
    try {
        const usersCount = (await pool.query('SELECT COUNT(*) AS c FROM users')).rows[0].c;
        const verifiedCount = (await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_verified = TRUE')).rows[0].c;
        const pendingDocs = (await pool.query("SELECT COUNT(*) AS c FROM documents WHERE status = 'pending'")).rows[0].c;
        const txCount = (await pool.query('SELECT COUNT(*) AS c FROM transactions')).rows[0].c;
        const totalBalance = (await pool.query('SELECT COALESCE(SUM(balance_points), 0) AS s FROM users')).rows[0].s;

        const message =
            `📊 *إحصائيات النظام*\n\n` +
            `👥 *إجمالي المستخدمين:* ${formatNumber(usersCount)}\n` +
            `✅ *المستخدمون الموثقون:* ${formatNumber(verifiedCount)}\n` +
            `⏳ *طلبات توثيق معلقة:* ${formatNumber(pendingDocs)}\n` +
            `💸 *إجمالي المعاملات:* ${formatNumber(txCount)}\n` +
            `💰 *إجمالي النقاط:* ${formatNumber(totalBalance)}`;

        await safeEdit(ctx, message, { parse_mode: 'Markdown', ...homeKeyboard() });
    } catch (e) {
        console.error('خطأ في الإحصائيات:', e.message);
        await ctx.reply('❌ حدث خطأ أثناء جلب الإحصائيات.');
    }
}

// =====================================
// استقبال النصوص
// =====================================

bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const state = getState(ctx);

    if (state.step === 'reject_reason' && state.rejectDocId) {
        const reason = ctx.message.text.trim();
        if (!reason) {
            return ctx.reply('⚠️ يرجى إرسال سبب الرفض.');
        }

        const docId = state.rejectDocId;
        setState(ctx, { step: 'main', rejectDocId: null });

        return handleRejectReason(ctx, docId, reason);
    }
});

// =====================================
// معالجة الأخطاء
// =====================================

bot.catch((error, ctx) => {
    console.error('خطأ في البوت:', error.message);
});

// =====================================
// تشغيل البوت
// =====================================

bot.launch()
    .then(() => {
        console.log('🤖 Telegram bot started successfully');
    })
    .catch((error) => {
        console.error('فشل تشغيل البوت:', error.message);
    });

// إغلاق نظيف
process.once('SIGINT', async () => {
    bot.stop('SIGINT');
    await pool.end();
});
process.once('SIGTERM', async () => {
    bot.stop('SIGTERM');
    await pool.end();
});
