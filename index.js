const { Telegraf } = require('telegraf');

// جلب التوكن من متغيّرات البيئة (Environment Variables)
const bot = new Telegraf(process.env.BOT_TOKEN);

// عند إرسال أمر /start
bot.start((ctx) => ctx.reply('هلا'));

// عند إرسال أي رسالة نصية أخرى للبوت
bot.on('text', (ctx) => ctx.reply('هلا'));

// تشغيل البوت
bot.launch();

console.log('البوت يعمل الآن...');

// إيقاف البوت بنظافة عند إغلاق السيرفر
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
