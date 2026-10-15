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
    res.send('بوت NOQAT الإداري يعمل بنجاح ✅');
});

app.listen(port, () => {
    console.log('HTTP server running on port ' + port);
});

// =====================================
// إعداد قاعدة البيانات
// =====================================

if (!process.env.DATABASE_URL) {
    console.error('خطأ: DATABASE_URL غير موجود');
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
    console.error('خطأ DB:', err.message);
});

// =====================================
// إعداد البوت
// =====================================

if (!process.env.BOT_TOKEN) {
    console.error('خطأ: BOT_TOKEN غير موجود');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// دعم عدة أدمن (يمكن إضافة أكثر من معرف مفصول بفواصل)
const ADMIN_IDS = String(process.env.ADMIN_CHAT_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const userState = new Map();

// =====================================
// أدوات مساعدة
// =====================================

function isAdmin(ctx) {
    return ADMIN_IDS.includes(String(ctx.from.id));
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toISOString().split('T')[0];
}

function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

function formatNumber(n) {
    return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

function getState(ctx) {
    return userState.get(ctx.from.id) || {};
}

function setState(ctx, values) {
    const old = getState(ctx);
    userState.set(ctx.from.id, { ...old, ...values });
}

function resetState(ctx) {
    userState.set(ctx.from.id, { step: 'main' });
}

function escapeMd(str) {
    if (!str) return '';
    return String(str).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function safeEdit(ctx, text, keyboard) {
    try {
        await ctx.editMessageText(text, keyboard);
    } catch (error) {
        if (error.description && error.description.includes('message is not modified')) {
            return;
        }
        await ctx.reply(text, keyboard);
    }
}

function normalizeMemberNumber(input) {
    if (!input) return null;
    let s = String(input).trim().toUpperCase();
    if (s.startsWith('NQ-')) s = s.substring(3);
    s = s.replace(/[^0-9]/g, '');
    if (!s) return null;
    return 'NQ-' + s;
}

// =====================================
// القوائم
// =====================================

function mainKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📋 طلبات التوثيق', 'pending_docs')],
        [Markup.button.callback('👥 إدارة الأعضاء', 'users_menu')],
        [Markup.button.callback('💰 إدارة الرصيد', 'balance_menu')],
        [Markup.button.callback('📊 الإحصائيات', 'stats')],
        [Markup.button.callback('💸 آخر المعاملات', 'recent_tx')]
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
        '🎛️ *الصلاحيات المتاحة:*\n' +
        '• إدارة طلبات التوثيق\n' +
        '• إدارة الأعضاء (حظر، تجميد، حذف)\n' +
        '• شحن وخصم وإهداء النقاط\n' +
        '• متابعة الإحصائيات والمعاملات\n\n' +
        'اختر العملية:';

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
        '`/start` — القائمة الرئيسية\n' +
        '`/stats` — الإحصائيات\n' +
        '`/users` — إدارة الأعضاء\n' +
        '`/gift NQ-12345678 100` — إهداء نقاط\n' +
        '`/credit NQ-12345678 100` — شحن\n' +
        '`/debit NQ-12345678 100` — خصم\n' +
        '`/find NQ-12345678` — البحث عن عضو',
        { parse_mode: 'Markdown' }
    );
});

bot.action('main', async (ctx) => {
    await ctx.answerCbQuery();
    resetState(ctx);
    await showMain(ctx, true);
});

// =====================================
// إدارة الأعضاء
// =====================================

bot.action('users_menu', async (ctx) => {
    await ctx.answerCbQuery();
    resetState(ctx);

    await safeEdit(
        ctx,
        '👥 *إدارة الأعضاء*\n\nاختر العملية:',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📋 عرض جميع الأعضاء', 'users_list_0')],
                [Markup.button.callback('🔍 البحث عن عضو', 'users_search')],
                [Markup.button.callback('✅ الموثقون', 'users_verified_0')],
                [Markup.button.callback('⏳ غير الموثقين', 'users_unverified_0')],
                [Markup.button.callback('🚫 المحظورون', 'users_suspended_0')],
                [Markup.button.callback('🏠 الرئيسية', 'main')]
            ])
        }
    );
});

// عرض قائمة الأعضاء مع التصفح
async function showUsersList(ctx, filter, page = 0, searchQuery = null) {
    const limit = 10;
    const offset = page * limit;

    let whereClause = '';
    const params = [];

    if (filter === 'verified') {
        whereClause = 'WHERE is_verified = TRUE';
    } else if (filter === 'unverified') {
        whereClause = 'WHERE is_verified = FALSE';
    } else if (filter === 'suspended') {
        whereClause = "WHERE status = 'suspended'";
    } else if (filter === 'search' && searchQuery) {
        whereClause = 'WHERE username ILIKE $1 OR full_name ILIKE $1 OR member_number ILIKE $1';
        params.push('%' + searchQuery + '%');
    }

    const countQuery = `SELECT COUNT(*) AS c FROM users ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = Number(countResult.rows[0].c);

    const listQuery = `
        SELECT id, username, full_name, member_number, balance_points, 
               is_verified, status, is_admin, created_at
        FROM users
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const listResult = await pool.query(listQuery, [...params, limit, offset]);

    if (listResult.rowCount === 0) {
        return safeEdit(
            ctx,
            '📭 لا يوجد أعضاء مطابقون.',
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 رجوع', 'users_menu')],
                    [Markup.button.callback('🏠 الرئيسية', 'main')]
                ])
            }
        );
    }

    let text = `👥 *الأعضاء* (${total} إجمالي)\n`;
    text += `📄 الصفحة ${page + 1} من ${Math.ceil(total / limit)}\n\n`;

    for (const u of listResult.rows) {
        const verifiedMark = u.is_verified ? '✅' : '⏳';
        const adminMark = u.is_admin ? ' 👑' : '';
        const statusMark = u.status === 'suspended' ? ' 🚫' : (u.status === 'active' ? ' 🟢' : ' ⚪');
        text += `${verifiedMark}${adminMark}${statusMark} *${escapeMd(u.full_name)}*\n`;
        text += `   @${escapeMd(u.username)} | \`${u.member_number}\`\n`;
        text += `   💰 ${formatNumber(u.balance_points)} | ID: \`${u.id}\`\n\n`;
    }

    // أزرار التصفح
    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('⬅️ السابق', `users_${filter}_${page - 1}${searchQuery ? '_' + searchQuery : ''}`));
    if (offset + limit < total) navButtons.push(Markup.button.callback('➡️ التالي', `users_${filter}_${page + 1}${searchQuery ? '_' + searchQuery : ''}`));

    const buttons = [];
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([Markup.button.callback('🔙 رجوع', 'users_menu')]);
    buttons.push([Markup.button.callback('🏠 الرئيسية', 'main')]);

    await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

bot.action(/^users_list_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showUsersList(ctx, 'all', Number(ctx.match[1]));
});

bot.action(/^users_verified_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showUsersList(ctx, 'verified', Number(ctx.match[1]));
});

bot.action(/^users_unverified_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showUsersList(ctx, 'unverified', Number(ctx.match[1]));
});

bot.action(/^users_suspended_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showUsersList(ctx, 'suspended', Number(ctx.match[1]));
});

bot.action('users_search', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx, { step: 'search_user' });
    await ctx.reply(
        '🔍 أرسل اسم المستخدم أو رقم العضوية أو الاسم الكامل للبحث:',
        homeKeyboard()
    );
});

// =====================================
// عرض تفاصيل عضو
// =====================================

async function showUserDetails(ctx, userId) {
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) {
        return ctx.reply('❌ العضو غير موجود.');
    }

    const doc = (await pool.query(
        'SELECT status, rejection_reason FROM documents WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [userId]
    )).rows[0];

    const txCount = (await pool.query(
        'SELECT COUNT(*) AS c FROM transactions WHERE sender_user_id = $1 OR receiver_user_id = $1',
        [userId]
    )).rows[0].c;

    let text = `👤 *تفاصيل العضو*\n\n`;
    text += `🆔 *ID:* \`${u.id}\`\n`;
    text += `👤 *الاسم:* ${escapeMd(u.full_name)}\n`;
    text += `📛 *اسم المستخدم:* @${escapeMd(u.username)}\n`;
    text += `🔢 *رقم العضوية:* \`${u.member_number}\`\n`;
    text += `📱 *الهاتف:* ${u.phone ? escapeMd(u.phone) : '—'}\n`;
    text += `💰 *الرصيد:* ${formatNumber(u.balance_points)} نقطة\n`;
    text += `✅ *موثق:* ${u.is_verified ? 'نعم' : 'لا'}\n`;
    text += `👑 *مشرف:* ${u.is_admin ? 'نعم' : 'لا'}\n`;
    text += `⚪ *الحالة:* ${u.status}\n`;
    text += `📅 *تاريخ التسجيل:* ${formatDate(u.created_at)}\n`;

    if (u.national_id) text += `🆔 *الرقم الوطني:* \`${u.national_id}\`\n`;
    if (u.date_of_birth) text += `🎂 *تاريخ الميلاد:* ${formatDate(u.date_of_birth)}\n`;

    if (doc) {
        text += `\n📄 *حالة التوثيق:* ${doc.status}\n`;
        if (doc.rejection_reason) text += `📝 *السبب:* ${escapeMd(doc.rejection_reason)}\n`;
    }

    text += `\n💸 *عدد المعاملات:* ${formatNumber(txCount)}`;

    const buttons = [
        [Markup.button.callback('💰 شحن رصيد', `user_credit_${u.id}`),
         Markup.button.callback('💸 خصم رصيد', `user_debit_${u.id}`)],
        [Markup.button.callback('🎁 إهداء نقاط', `user_gift_${u.id}`)],
    ];

    if (u.is_verified) {
        buttons.push([Markup.button.callback('❌ إلغاء التوثيق', `user_unverify_${u.id}`)]);
    } else {
        buttons.push([Markup.button.callback('✅ توثيق يدوياً', `user_verify_${u.id}`)]);
    }

    if (u.status === 'suspended') {
        buttons.push([Markup.button.callback('🟢 إلغاء الحظر', `user_activate_${u.id}`)]);
    } else {
        buttons.push([Markup.button.callback('🚫 حظر العضو', `user_suspend_${u.id}`)]);
    }

    buttons.push([Markup.button.callback('🗑️ حذف الحساب', `user_delete_${u.id}`)]);
    buttons.push([Markup.button.callback('🔙 رجوع', 'users_menu')]);

    await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

bot.action(/^user_view_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showUserDetails(ctx, Number(ctx.match[1]));
});

// =====================================
// الحظر / التنشيط / الحذف
// =====================================

bot.action(/^user_suspend_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    if (ADMIN_IDS.includes(String(userId))) {
        return ctx.answerCbQuery('لا يمكن حظر مشرف', { show_alert: true });
    }

    await pool.query(
        'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2',
        ['suspended', userId]
    );
    await pool.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
         VALUES (NULL, 'bot_suspend', $1, $2)`,
        [userId, JSON.stringify({ via: 'telegram_bot' })]
    );

    await ctx.answerCbQuery('✅ تم الحظر', { show_alert: true });
    await showUserDetails(ctx, userId);
});

bot.action(/^user_activate_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    await pool.query(
        'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2',
        ['active', userId]
    );
    await pool.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
         VALUES (NULL, 'bot_reactivate', $1, $2)`,
        [userId, JSON.stringify({ via: 'telegram_bot' })]
    );

    await ctx.answerCbQuery('✅ تم التنشيط', { show_alert: true });
    await showUserDetails(ctx, userId);
});

bot.action(/^user_delete_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    await safeEdit(
        ctx,
        `⚠️ *تأكيد الحذف*\n\nهل أنت متأكد من حذف العضو رقم \`${userId}\`؟\n` +
        `سيتم حذف جميع بياناته ولا يمكن التراجع.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ نعم، احذف', `user_delete_confirm_${userId}`)],
                [Markup.button.callback('❌ إلغاء', `user_view_${userId}`)]
            ])
        }
    );
});

bot.action(/^user_delete_confirm_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    try {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await pool.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, 'bot_delete', $1, $2)`,
            [userId, JSON.stringify({ via: 'telegram_bot' })]
        );
        await safeEdit(ctx, `✅ تم حذف العضو رقم \`${userId}\``, {
            parse_mode: 'Markdown',
            ...homeKeyboard()
        });
    } catch (e) {
        await ctx.reply('❌ فشل الحذف: ' + e.message);
    }
});

// =====================================
// التوثيق اليدوي / الإلغاء
// =====================================

bot.action(/^user_verify_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    await pool.query(
        'UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1',
        [userId]
    );
    await ctx.answerCbQuery('✅ تم التوثيق', { show_alert: true });
    await showUserDetails(ctx, userId);
});

bot.action(/^user_unverify_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = Number(ctx.match[1]);

    await pool.query(
        'UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1',
        [userId]
    );
    await ctx.answerCbQuery('✅ تم إلغاء التوثيق', { show_alert: true });
    await showUserDetails(ctx, userId);
});

// =====================================
// إدارة الرصيد - شحن / خصم / إهداء
// =====================================

bot.action('balance_menu', async (ctx) => {
    await ctx.answerCbQuery();
    resetState(ctx);

    await safeEdit(
        ctx,
        '💰 *إدارة الرصيد*\n\n' +
        'يمكنك تنفيذ العمليات عبر الأوامر النصية:\n\n' +
        '• `/credit NQ-12345678 100` — شحن رصيد\n' +
        '• `/debit NQ-12345678 100` — خصم رصيد\n' +
        '• `/gift NQ-12345678 100` — إهداء نقاط\n\n' +
        'أو استخدم الأزرار أدناه، ثم اختر العضو.',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💰 شحن', 'balance_action_credit')],
                [Markup.button.callback('💸 خصم', 'balance_action_debit')],
                [Markup.button.callback('🎁 إهداء', 'balance_action_gift')],
                [Markup.button.callback('🏠 الرئيسية', 'main')]
            ])
        }
    );
});

bot.action(/^balance_action_(credit|debit|gift)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];

    setState(ctx, { step: 'balance_select_user', balanceAction: action });

    const actionName = action === 'credit' ? 'الشحن' :
                       action === 'debit' ? 'الخصم' : 'الإهداء';

    await ctx.reply(
        `💰 *${actionName}*\n\nأرسل رقم العضوية الآن.\nمثال: \`NQ-12345678\``,
        { parse_mode: 'Markdown', ...homeKeyboard() }
    );
});

bot.action(/^user_(credit|debit|gift)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const userId = Number(ctx.match[2]);

    const u = (await pool.query('SELECT member_number FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) return ctx.reply('❌ العضو غير موجود.');

    setState(ctx, { step: 'balance_amount', balanceAction: action, targetUserId: userId });

    const actionName = action === 'credit' ? 'الشحن' :
                       action === 'debit' ? 'الخصم' : 'الإهداء';

    await ctx.reply(
        `💰 *${actionName}* للعضو \`${u.member_number}\`\n\n` +
        `أرسل عدد النقاط الآن (رقم فقط):`,
        { parse_mode: 'Markdown', ...homeKeyboard() }
    );
});

async function executeBalanceAction(ctx, action, userId, amount) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const uR = await client.query(
            'SELECT * FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );
        if (uR.rowCount === 0) {
            await client.query('ROLLBACK');
            return ctx.reply('❌ العضو غير موجود.');
        }
        const target = uR.rows[0];

        if (action === 'debit' && Number(target.balance_points) < amount) {
            await client.query('ROLLBACK');
            return ctx.reply(
                `❌ الرصيد الحالي (${formatNumber(target.balance_points)}) أقل من المبلغ المطلوب (${formatNumber(amount)}).`
            );
        }

        const sign = (action === 'debit') ? -1 : 1;

        await client.query(
            'UPDATE users SET balance_points = balance_points + $1, updated_at = NOW() WHERE id = $2',
            [sign * amount, userId]
        );

        const ref = 'TX-' + Date.now().toString(36).toUpperCase() +
                    Math.random().toString(16).substring(2, 6).toUpperCase();

        const type = action === 'credit' ? 'admin_credit' :
                     action === 'debit' ? 'admin_debit' : 'admin_gift';

        const description = action === 'credit' ? 'شحن من الإدارة' :
                            action === 'debit' ? 'خصم إداري' : 'إهداء من الإدارة';

        if (action === 'debit') {
            await client.query(
                `INSERT INTO transactions
                 (reference_number, type, amount_points, fee_points, sender_user_id, description)
                 VALUES ($1, $2, $3, 0, $4, $5)`,
                [ref, type, amount, userId, description]
            );
        } else {
            await client.query(
                `INSERT INTO transactions
                 (reference_number, type, amount_points, fee_points, receiver_user_id, description)
                 VALUES ($1, $2, $3, 0, $4, $5)`,
                [ref, type, amount, userId, description]
            );
        }

        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, $1, $2, $3)`,
            [`bot_${type}`, userId, JSON.stringify({ amount, ref, via: 'telegram_bot' })]
        );

        await client.query('COMMIT');

        const newBalance = Number(target.balance_points) + sign * amount;
        const actionLabel = action === 'credit' ? 'شحن' :
                            action === 'debit' ? 'خصم' : 'إهداء';

        await ctx.reply(
            `✅ *تم ${actionLabel} بنجاح*\n\n` +
            `👤 *العضو:* ${escapeMd(target.full_name)}\n` +
            `🔢 *رقم العضوية:* \`${target.member_number}\`\n` +
            `💰 *المبلغ:* ${formatNumber(amount)}\n` +
            `💵 *الرصيد الجديد:* ${formatNumber(newBalance)}\n` +
            `🧾 *رقم العملية:* \`${ref}\``,
            { parse_mode: 'Markdown', ...homeKeyboard() }
        );
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('خطأ:', e.message);
        await ctx.reply('❌ حدث خطأ: ' + e.message);
    } finally {
        client.release();
    }
}

// =====================================
// الأوامر النصية: gift / credit / debit / find
// =====================================

bot.command('gift', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply('⚠️ الصيغة: `/gift NQ-12345678 100`', { parse_mode: 'Markdown' });
    }
    const memberNumber = normalizeMemberNumber(parts[1]);
    const amount = parseInt(parts[2], 10);
    if (!memberNumber || !Number.isInteger(amount) || amount <= 0) {
        return ctx.reply('❌ رقم العضوية أو المبلغ غير صحيح.');
    }
    const u = (await pool.query('SELECT id FROM users WHERE member_number = $1', [memberNumber])).rows[0];
    if (!u) return ctx.reply('❌ لا يوجد عضو بهذا الرقم.');
    await executeBalanceAction(ctx, 'gift', u.id, amount);
});

bot.command('credit', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply('⚠️ الصيغة: `/credit NQ-12345678 100`', { parse_mode: 'Markdown' });
    }
    const memberNumber = normalizeMemberNumber(parts[1]);
    const amount = parseInt(parts[2], 10);
    if (!memberNumber || !Number.isInteger(amount) || amount <= 0) {
        return ctx.reply('❌ رقم العضوية أو المبلغ غير صحيح.');
    }
    const u = (await pool.query('SELECT id FROM users WHERE member_number = $1', [memberNumber])).rows[0];
    if (!u) return ctx.reply('❌ لا يوجد عضو بهذا الرقم.');
    await executeBalanceAction(ctx, 'credit', u.id, amount);
});

bot.command('debit', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply('⚠️ الصيغة: `/debit NQ-12345678 100`', { parse_mode: 'Markdown' });
    }
    const memberNumber = normalizeMemberNumber(parts[1]);
    const amount = parseInt(parts[2], 10);
    if (!memberNumber || !Number.isInteger(amount) || amount <= 0) {
        return ctx.reply('❌ رقم العضوية أو المبلغ غير صحيح.');
    }
    const u = (await pool.query('SELECT id FROM users WHERE member_number = $1', [memberNumber])).rows[0];
    if (!u) return ctx.reply('❌ لا يوجد عضو بهذا الرقم.');
    await executeBalanceAction(ctx, 'debit', u.id, amount);
});

bot.command('find', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 2) {
        return ctx.reply('⚠️ الصيغة: `/find NQ-12345678`', { parse_mode: 'Markdown' });
    }
    const memberNumber = normalizeMemberNumber(parts[1]);
    const u = (await pool.query('SELECT id FROM users WHERE member_number = $1', [memberNumber])).rows[0];
    if (!u) return ctx.reply('❌ لا يوجد عضو بهذا الرقم.');
    await showUserDetails(ctx, u.id);
});

// =====================================
// طلبات التوثيق
// =====================================

bot.action('pending_docs', async (ctx) => {
    await ctx.answerCbQuery();

    try {
        const r = await pool.query(
            `SELECT d.id, d.national_id, d.full_name_4, d.date_of_birth,
                    d.image_data, d.created_at,
                    u.username, u.member_number, u.full_name, u.id AS user_id
             FROM documents d
             JOIN users u ON u.id = d.user_id
             WHERE d.status = 'pending'
             ORDER BY d.created_at ASC
             LIMIT 10`
        );

        if (r.rowCount === 0) {
            return ctx.reply('✅ لا توجد طلبات معلقة.', homeKeyboard());
        }

        await ctx.reply(`📋 *${r.rowCount} طلب معلق:*`, { parse_mode: 'Markdown' });

        for (const doc of r.rows) {
            const caption =
                `👤 *الاسم:* ${escapeMd(doc.full_name_4)}\n` +
                `🆔 *الرقم الوطني:* \`${doc.national_id}\`\n` +
                `🎂 *الميلاد:* ${formatDate(doc.date_of_birth)}\n` +
                `📅 *التقديم:* ${formatDate(doc.created_at)}\n\n` +
                `👥 *صاحب الحساب:*\n` +
                `• @${escapeMd(doc.username)}\n` +
                `• \`${doc.member_number}\`\n` +
                `• ID: \`${doc.user_id}\``;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ قبول', `approve_doc_${doc.id}`),
                    Markup.button.callback('❌ رفض', `reject_doc_${doc.id}`)
                ]
            ]);

            try {
                const base64Data = (doc.image_data || '').replace(/^data:image\/\w+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                await ctx.replyWithPhoto(
                    { source: imageBuffer },
                    { caption, parse_mode: 'Markdown', ...keyboard }
                );
            } catch (err) {
                await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
            }
        }

        await ctx.reply('— انتهى —', homeKeyboard());
    } catch (e) {
        console.error(e.message);
        await ctx.reply('❌ خطأ: ' + e.message);
    }
});

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
            return ctx.reply('⚠️ المستند غير موجود أو تمت مراجعته.');
        }

        const doc = docR.rows[0];

        await client.query(
            'UPDATE documents SET status = $1, reviewed_at = NOW() WHERE id = $2',
            ['approved', docId]
        );
        await client.query(
            `UPDATE users SET is_verified = TRUE, national_id = $1, date_of_birth = $2, updated_at = NOW() WHERE id = $3`,
            [doc.national_id, doc.date_of_birth, doc.user_id]
        );
        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
             VALUES (NULL, 'bot_approve_doc', $1, $2)`,
            [doc.user_id, JSON.stringify({ documentId: docId })]
        );

        await client.query('COMMIT');

        await ctx.editMessageCaption(
            `✅ *تم قبول التوثيق*\n\n👤 ${escapeMd(doc.full_name_4)}\n🆔 \`${doc.national_id}\``,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        await ctx.reply('✅ تم التوثيق بنجاح.', homeKeyboard());
    } catch (e) {
        await client.query('ROLLBACK');
        await ctx.reply('❌ خطأ: ' + e.message);
    } finally {
        client.release();
    }
});

bot.action(/^reject_doc_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const docId = Number(ctx.match[1]);
    setState(ctx, { step: 'reject_reason', rejectDocId: docId });
    await ctx.reply(`✍️ أرسل سبب رفض المستند رقم \`${docId}\`:`, { parse_mode: 'Markdown' });
});

// =====================================
// الإحصائيات
// =====================================

bot.action('stats', async (ctx) => {
    await ctx.answerCbQuery();
    await showStats(ctx);
});

bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await showStats(ctx);
});

async function showStats(ctx) {
    try {
        const totalUsers = (await pool.query('SELECT COUNT(*) AS c FROM users')).rows[0].c;
        const verified = (await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_verified = TRUE')).rows[0].c;
        const suspended = (await pool.query("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'")).rows[0].c;
        const pending = (await pool.query("SELECT COUNT(*) AS c FROM documents WHERE status = 'pending'")).rows[0].c;
        const approved = (await pool.query("SELECT COUNT(*) AS c FROM documents WHERE status = 'approved'")).rows[0].c;
        const rejected = (await pool.query("SELECT COUNT(*) AS c FROM documents WHERE status = 'rejected'")).rows[0].c;
        const txCount = (await pool.query('SELECT COUNT(*) AS c FROM transactions')).rows[0].c;
        const totalBalance = (await pool.query('SELECT COALESCE(SUM(balance_points), 0) AS s FROM users')).rows[0].s;
        const todayTx = (await pool.query("SELECT COUNT(*) AS c FROM transactions WHERE created_at >= NOW() - INTERVAL '24 hours'")).rows[0].c;

        const message =
            `📊 *إحصائيات النظام*\n\n` +
            `👥 *المستخدمون:*\n` +
            `• الإجمالي: ${formatNumber(totalUsers)}\n` +
            `• الموثقون: ${formatNumber(verified)}\n` +
            `• المحظورون: ${formatNumber(suspended)}\n\n` +
            `📄 *التوثيق:*\n` +
            `• معلقة: ${formatNumber(pending)}\n` +
            `• مقبولة: ${formatNumber(approved)}\n` +
            `• مرفوضة: ${formatNumber(rejected)}\n\n` +
            `💸 *المعاملات:*\n` +
            `• الإجمالي: ${formatNumber(txCount)}\n` +
            `• آخر 24 ساعة: ${formatNumber(todayTx)}\n\n` +
            `💰 *إجمالي النقاط:* ${formatNumber(totalBalance)}`;

        await safeEdit(ctx, message, { parse_mode: 'Markdown', ...homeKeyboard() });
    } catch (e) {
        await ctx.reply('❌ خطأ: ' + e.message);
    }
}

// =====================================
// آخر المعاملات
// =====================================

bot.action('recent_tx', async (ctx) => {
    await ctx.answerCbQuery();

    const r = await pool.query(
        `SELECT t.*,
                s.full_name AS sender_name, s.member_number AS sender_member,
                r.full_name AS receiver_name, r.member_number AS receiver_member
         FROM transactions t
         LEFT JOIN users s ON s.id = t.sender_user_id
         LEFT JOIN users r ON r.id = t.receiver_user_id
         ORDER BY t.created_at DESC
         LIMIT 10`
    );

    if (r.rowCount === 0) {
        return safeEdit(ctx, '📭 لا توجد معاملات.', { parse_mode: 'Markdown', ...homeKeyboard() });
    }

    let text = `💸 *آخر ${r.rowCount} معاملات:*\n\n`;

    for (const t of r.rows) {
        text += `🧾 \`${t.reference_number}\`\n`;
        text += `   النوع: ${t.type} | ${formatNumber(t.amount_points)} نقطة\n`;
        if (t.sender_name) text += `   من: ${escapeMd(t.sender_name)}\n`;
        if (t.receiver_name) text += `   إلى: ${escapeMd(t.receiver_name)}\n`;
        text += `   📅 ${formatDateTime(t.created_at)}\n\n`;
    }

    await safeEdit(ctx, text, { parse_mode: 'Markdown', ...homeKeyboard() });
});

// =====================================
// استقبال الرسائل النصية
// =====================================

bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    const state = getState(ctx);

    // سبب رفض التوثيق
    if (state.step === 'reject_reason' && state.rejectDocId) {
        const reason = text.trim();
        if (!reason) return ctx.reply('⚠️ أرسل سبباً.');
        const docId = state.rejectDocId;
        setState(ctx, { step: 'main', rejectDocId: null });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const docR = await client.query(
                'SELECT * FROM documents WHERE id = $1 AND status = $2 FOR UPDATE',
                [docId, 'pending']
            );
            if (docR.rowCount === 0) {
                await client.query('ROLLBACK');
                return ctx.reply('⚠️ المستند غير موجود.');
            }
            const doc = docR.rows[0];
            await client.query(
                'UPDATE documents SET status = $1, reviewed_at = NOW(), rejection_reason = $2 WHERE id = $3',
                ['rejected', reason, docId]
            );
            await client.query(
                'UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1',
                [doc.user_id]
            );
            await client.query(
                `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
                 VALUES (NULL, 'bot_reject_doc', $1, $2)`,
                [doc.user_id, JSON.stringify({ documentId: docId, reason })]
            );
            await client.query('COMMIT');
            await ctx.reply(
                `❌ *تم الرفض*\n\n👤 ${escapeMd(doc.full_name_4)}\n📝 السبب: ${escapeMd(reason)}`,
                { parse_mode: 'Markdown', ...homeKeyboard() }
            );
        } catch (e) {
            await client.query('ROLLBACK');
            await ctx.reply('❌ خطأ: ' + e.message);
        } finally {
            client.release();
        }
        return;
    }

    // البحث عن عضو
    if (state.step === 'search_user') {
        setState(ctx, { step: 'main' });
        const r = await pool.query(
            `SELECT id, username, full_name, member_number, balance_points, is_verified, status
             FROM users
             WHERE username ILIKE $1 OR full_name ILIKE $1 OR member_number ILIKE $1
             LIMIT 10`,
            ['%' + text.trim() + '%']
        );

        if (r.rowCount === 0) {
            return ctx.reply('❌ لا نتائج.', homeKeyboard());
        }

        const buttons = r.rows.map(u => {
            const mark = u.is_verified ? '✅' : '⏳';
            return [Markup.button.callback(
                `${mark} ${u.full_name} — ${u.member_number}`,
                `user_view_${u.id}`
            )];
        });
        buttons.push([Markup.button.callback('🏠 الرئيسية', 'main')]);

        return ctx.reply(`🔍 *${r.rowCount} نتائج:*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }

    // اختيار مستخدم لعمليات الرصيد
    if (state.step === 'balance_select_user' && state.balanceAction) {
        const memberNumber = normalizeMemberNumber(text);
        if (!memberNumber) return ctx.reply('❌ رقم غير صحيح.');

        const u = (await pool.query('SELECT id, member_number, full_name FROM users WHERE member_number = $1', [memberNumber])).rows[0];
        if (!u) return ctx.reply('❌ لا يوجد عضو.');

        setState(ctx, { step: 'balance_amount', targetUserId: u.id });
        return ctx.reply(
            `💰 العضو: ${escapeMd(u.full_name)}\n\`${u.member_number}\`\n\nأرسل عدد النقاط:`,
            { parse_mode: 'Markdown', ...homeKeyboard() }
        );
    }

    // إدخال مبلغ الرصيد
    if (state.step === 'balance_amount' && state.balanceAction && state.targetUserId) {
        const amount = parseInt(text.trim(), 10);
        if (!Number.isInteger(amount) || amount <= 0) {
            return ctx.reply('❌ المبلغ غير صحيح.');
        }
        const action = state.balanceAction;
        const userId = state.targetUserId;
        setState(ctx, { step: 'main', balanceAction: null, targetUserId: null });
        return executeBalanceAction(ctx, action, userId, amount);
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
    .then(() => console.log('🤖 Bot started successfully'))
    .catch((error) => console.error('فشل التشغيل:', error.message));

process.once('SIGINT', async () => {
    bot.stop('SIGINT');
    await pool.end();
});
process.once('SIGTERM', async () => {
    bot.stop('SIGTERM');
    await pool.end();
});
