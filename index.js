const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
res.send('مكتبة كلية الهندسة - جامعة كسلا تعمل بنجاح');
});

app.listen(port, () => {
console.log("HTTP server running on port ${port}");
});

if (!process.env.BOT_TOKEN) {
console.error('خطأ: يرجى ضبط BOT_TOKEN في إعدادات البيئة');
process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const DATA_FILE = path.join(__dirname, 'data', 'library.json');

function loadLibrary() {
try {
return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (error) {
console.error('تعذر قراءة ملف المكتبة:', error.message);
return {};
}
}

function saveLibrary(data) {
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const userState = new Map();

function getState(ctx) {
return userState.get(ctx.from.id) || {};
}

function setState(ctx, values) {
userState.set(ctx.from.id, {
...getState(ctx),
...values
});
}

function mainKeyboard() {
return Markup.inlineKeyboard([
[Markup.button.callback('📚 المحتوى الأكاديمي', 'academic')],
[Markup.button.callback('ℹ️ معلومات عن المكتبة', 'library_info')],
[Markup.button.callback('🔍 البحث عن مقرر', 'search_course')],
[Markup.button.callback('📩 التواصل مع الإدارة', 'contact')]
]);
}

function backKeyboard(action = 'main') {
return Markup.inlineKeyboard([
[Markup.button.callback('🏠 القائمة الرئيسية', action)]
]);
}

async function showMain(ctx, edit = false) {
const message =
'🎓 مرحباً بك في المكتبة الإلكترونية\n' +
'🏛️ جامعة كسلا — كلية الهندسة\n\n' +
'أهلاً بك عزيزي الطالب!\n\n' +
'يمكنك تصفح المقررات الدراسية والمحاضرات والامتحانات السابقة.\n\n' +
'اختر الخدمة التي تريدها:';

const keyboard = mainKeyboard();

if (edit && ctx.callbackQuery) {
try {
await ctx.editMessageText(message, keyboard);
return;
} catch (e) {
// إذا تعذر تعديل الرسالة، نرسل رسالة جديدة
}
}

await ctx.reply(message, keyboard);
}

bot.start(async (ctx) => {
setState(ctx, { step: 'main' });
await showMain(ctx);
});

bot.command('help', async (ctx) => {
await ctx.reply(
'استخدم الأزرار للتنقل داخل المكتبة.\n' +
'للبدء من جديد أرسل /start'
);
});

bot.action('main', async (ctx) => {
await ctx.answerCbQuery();
setState(ctx, { step: 'main' });
await showMain(ctx, true);
});

bot.action('academic', async (ctx) => {
await ctx.answerCbQuery();
setState(ctx, { step: 'specialty' });

await ctx.editMessageText(
'📚 المحتوى الأكاديمي\n\nاختر تخصصك:',
Markup.inlineKeyboard([
[Markup.button.callback('⚙️ ميكانيكا', 'spec_mechanical')],
[Markup.button.callback('🏗️ مدنية', 'spec_civil')],
[Markup.button.callback('⚡ كهرباء', 'spec_electrical')],
[Markup.button.callback('🔙 رجوع', 'main')]
])
);
});

const specialties = {
mechanical: 'ميكانيكا',
civil: 'مدنية',
electrical: 'كهرباء'
};

for (const [key, label] of Object.entries(specialties)) {
bot.action("spec_${key}", async (ctx) => {
await ctx.answerCbQuery();

setState(ctx, {
  specialty: key,
  specialtyName: label,
  step: 'level'
});

const buttons = [];

for (let level = 1; level <= 5; level++) {
  buttons.push([
    Markup.button.callback(
      `المستوى ${level}`,
      `level_${level}`
    )
  ]);
}

buttons.push([
  Markup.button.callback('🔙 تغيير التخصص', 'academic')
]);

await ctx.editMessageText(
  `📘 تخصص ${label}\n\nاختر المستوى الدراسي:`,
  Markup.inlineKeyboard(buttons)
);

});
}

bot.action(/^level_([1-5])$/, async (ctx) => {
await ctx.answerCbQuery();

const level = Number(ctx.match[1]);

setState(ctx, {
level,
step: 'semester'
});

await ctx.editMessageText(
"📘 المستوى ${level}\n\nاختر الفصل الدراسي:",
Markup.inlineKeyboard([
[
Markup.button.callback('📗 الفصل الأول', 'semester_1')
],
[
Markup.button.callback('📙 الفصل الثاني', 'semester_2')
],
[
Markup.button.callback('🔙 تغيير المستوى', 'academic')
]
])
);
});

bot.action(/^semester_([12])$/, async (ctx) => {
await ctx.answerCbQuery();

const semester = Number(ctx.match[1]);

setState(ctx, {
semester,
step: 'courses'
});

const state = getState(ctx);
const library = loadLibrary();

const courses =
library[state.specialty] &&
library[state.specialty][String(state.level)] &&
library[state.specialty][String(state.level)][String(semester)];

if (!courses || Object.keys(courses).length === 0) {
await ctx.editMessageText(
'📂 لا توجد مقررات مضافة لهذا الفصل حتى الآن.\n\n' +
'يمكنك العودة واختيار فصل آخر.',
Markup.inlineKeyboard([
[Markup.button.callback('🔙 تغيير الفصل', 'academic')],
[Markup.button.callback('🏠 القائمة الرئيسية', 'main')]
])
);
return;
}

const buttons = Object.entries(courses).map(([id, course]) => [
Markup.button.callback(course.name, "course_${id}")
]);

buttons.push([
Markup.button.callback('🔙 القائمة الرئيسية', 'main')
]);

await ctx.editMessageText(
"📚 المقررات الدراسية\n\n" +
"التخصص: ${state.specialtyName}\n" +
"المستوى: ${state.level}\n" +
"الفصل: ${semester === 1 ? 'الأول' : 'الثاني'}\n\n" +
'اختر المقرر:',
Markup.inlineKeyboard(buttons)
);
});

bot.action(/^course_(.+)$/, async (ctx) => {
await ctx.answerCbQuery();

const courseId = ctx.match[1];
const state = getState(ctx);
const library = loadLibrary();

const courses =
library[state.specialty] &&
library[state.specialty][String(state.level)] &&
library[state.specialty][String(state.level)][String(state.semester)];

const course = courses && courses[courseId];

if (!course) {
await ctx.reply('عذراً، لم أجد هذا المقرر. أعد اختيار الفصل.');
return;
}

setState(ctx, {
courseId,
courseName: course.name,
step: 'course_files'
});

await ctx.editMessageText(
"📘 المقرر: ${course.name}\n\nاختر نوع المحتوى الذي تريد عرضه:",
Markup.inlineKeyboard([
[Markup.button.callback('📚 المحاضرات', 'files_lectures')],
[Markup.button.callback('📝 الامتحانات السابقة', 'files_exams')],
[Markup.button.callback('📑 الملخصات', 'files_summaries')],
[Markup.button.callback('🔙 المقررات', 'back_courses')],
[Markup.button.callback('🏠 الرئيسية', 'main')]
])
);
});

bot.action('back_courses', async (ctx) => {
await ctx.answerCbQuery();

const state = getState(ctx);

if (!state.specialty || !state.level || !state.semester) {
await showMain(ctx, true);
return;
}

const library = loadLibrary();

const courses =
library[state.specialty] &&
library[state.specialty][String(state.level)] &&
library[state.specialty][String(state.level)][String(state.semester)];

if (!courses || Object.keys(courses).length === 0) {
await ctx.editMessageText(
'لا توجد مقررات مضافة.',
backKeyboard('academic')
);
return;
}

const buttons = Object.entries(courses).map(([id, course]) => [
Markup.button.callback(course.name, "course_${id}")
]);

buttons.push([
Markup.button.callback('🏠 الرئيسية', 'main')
]);

await ctx.editMessageText(
'📚 اختر المقرر:',
Markup.inlineKeyboard(buttons)
);
});

const contentTypes = {
lectures: 'المحاضرات',
exams: 'الامتحانات السابقة',
summaries: 'الملخصات'
};

for (const [key, label] of Object.entries(contentTypes)) {
bot.action("files_${key}", async (ctx) => {
await ctx.answerCbQuery();

const state = getState(ctx);
const library = loadLibrary();

const course =
  library[state.specialty] &&
  library[state.specialty][String(state.level)] &&
  library[state.specialty][String(state.level)][String(state.semester)] &&
  library[state.specialty][String(state.level)][String(state.semester)][state.courseId];

if (!course) {
  await ctx.reply('لم أتمكن من العثور على المقرر.');
  return;
}

const files = course[key] || [];

if (files.length === 0) {
  await ctx.reply(
    `📂 لا توجد ملفات ضمن قسم ${label} لهذا المقرر حتى الآن.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔙 العودة للمقرر', `course_${state.courseId}`)],
      [Markup.button.callback('🏠 الرئيسية', 'main')]
    ])
  );
  return;
}

await ctx.reply(
  `📂 ${label} — ${course.name}\n\n` +
  'اختر الملف المطلوب:'
);

for (const file of files) {
  try {
    const options = {
      caption: file.title || course.name
    };

    if (file.file_id) {
      await ctx.replyWithDocument(file.file_id, options);
    } else if (file.url) {
      await ctx.replyWithDocument(
        { url: file.url, filename: file.filename || 'document.pdf' },
        options
      );
    }
  } catch (error) {
    console.error('فشل إرسال الملف:', error.message);
    await ctx.reply(
      `تعذر إرسال الملف: ${file.title || file.filename || 'PDF'}`
    );
  }
}

await ctx.reply(
  'هل تريد شيئاً آخر؟',
  Markup.inlineKeyboard([
    [Markup.button.callback('🔙 العودة للمقرر', `course_${state.courseId}`)],
    [Markup.button.callback('🏠 الرئيسية', 'main')]
  ])
);

});
}

bot.action('library_info', async (ctx) => {
await ctx.answerCbQuery();

await ctx.editMessageText(
'ℹ️ معلومات عن المكتبة الإلكترونية\n\n' +
'هذه المكتبة مخصصة لتسهيل وصول طلاب كلية الهندسة بجامعة كسلا إلى المحتوى الأكاديمي.\n\n' +
'يمكن تنظيم المحتوى حسب التخصص والمستوى والفصل الدراسي، مع إتاحة المحاضرات والملخصات والامتحانات السابقة.\n\n' +
'ملاحظة: توفر الملفات يعتمد على المحتوى الذي تتم إضافته إلى المكتبة.',
Markup.inlineKeyboard([
[Markup.button.callback('📚 تصفح المحتوى', 'academic')],
[Markup.button.callback('🏠 الرئيسية', 'main')]
])
);
});

bot.action('contact', async (ctx) => {
await ctx.answerCbQuery();

await ctx.editMessageText(
'📩 التواصل مع إدارة المكتبة\n\n' +
'لم يتم تحديد حساب مسؤول المكتبة بعد.\n' +
'يمكن إضافة اسم المستخدم الخاص بالمسؤول في إعدادات المشروع.',
backKeyboard('main')
);
});

bot.action('search_course', async (ctx) => {
await ctx.answerCbQuery();

setState(ctx, { step: 'search' });

await ctx.reply(
'🔍 أرسل اسم المقرر الذي تريد البحث عنه.\n\n' +
'مثال: الديناميكا الحرارية'
);
});

bot.on('text', async (ctx) => {
const state = getState(ctx);

if (state.step !== 'search') {
return;
}

const query = ctx.message.text.trim().toLowerCase();
const library = loadLibrary();
const results = [];

for (const [specialty, levels] of Object.entries(library)) {
for (const [level, semesters] of Object.entries(levels || {})) {
for (const [semester, courses] of Object.entries(semesters || {})) {
for (const [id, course] of Object.entries(courses || {})) {
if (String(course.name || '').toLowerCase().includes(query)) {
results.push({
specialty,
level,
semester,
id,
name: course.name
});
}
}
}
}
}

setState(ctx, { step: 'main' });

if (results.length === 0) {
await ctx.reply(
'لم أجد مقرراً بهذا الاسم.\n' +
'تأكد من كتابة الاسم أو جرّب كلمة أخرى.',
mainKeyboard()
);
return;
}

const buttons = results.slice(0, 20).map((item, index) => [
Markup.button.callback(
"${item.name} — مستوى ${item.level}",
"search_result_${index}"
)
]);

setState(ctx, { searchResults: results.slice(0, 20) });

await ctx.reply(
"🔎 نتائج البحث: ${results.length}\n\nاختر المقرر:",
Markup.inlineKeyboard([
...buttons,
[Markup.button.callback('🏠 الرئيسية', 'main')]
])
);
});

bot.action(/^search_result_(\d+)$/, async (ctx) => {
await ctx.answerCbQuery();

const state = getState(ctx);
const item = (state.searchResults || [])[Number(ctx.match[1])];

if (!item) {
await ctx.reply('انتهت صلاحية نتيجة البحث. أعد البحث من فضلك.');
return;
}

setState(ctx, {
specialty: item.specialty,
specialtyName: specialties[item.specialty] || item.specialty,
level: Number(item.level),
semester: Number(item.semester),
courseId: item.id
});

const library = loadLibrary();
const course =
library[item.specialty][item.level][item.semester][item.id];

setState(ctx, { courseName: course.name });

await ctx.editMessageText(
"📘 ${course.name}\n\nاختر نوع المحتوى:",
Markup.inlineKeyboard([
[Markup.button.callback('📚 المحاضرات', 'files_lectures')],
[Markup.button.callback('📝 الامتحانات', 'files_exams')],
[Markup.button.callback('📑 الملخصات', 'files_summaries')],
[Markup.button.callback('🏠 الرئيسية', 'main')]
])
);
});

bot.catch((error, ctx) => {
console.error("Bot error for ${ctx.updateType}:", error);
});

bot.launch()
.then(() => console.log('Telegram bot started successfully'))
.catch((error) => console.error('Failed to start bot:', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
