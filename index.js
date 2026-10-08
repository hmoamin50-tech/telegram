const { Telegraf } = require('telegraf');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// فتح منفذ HTTP ليستجيب لطلبات Render ويمنع توقف الخدمة
app.get('/', (req, res) => {
  res.send('البوت يعمل بنجاح!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// إعداد كود البوت
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => ctx.reply('هلا'));
bot.on('text', (ctx) => ctx.reply('هلا'));

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
