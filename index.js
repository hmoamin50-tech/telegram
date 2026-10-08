const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// =====================================
// إعداد خادم HTTP
// =====================================

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('مكتبة كلية الهندسة - جامعة كسلا تعمل بنجاح');
});

app.listen(port, () => {
    console.log('HTTP server running on port ' + port);
});

// =====================================
// إعداد البوت
// =====================================

if (!process.env.BOT_TOKEN) {
    console.error('خطأ: BOT_TOKEN غير موجود في إعدادات البيئة');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const DATA_FILE = path.join(__dirname, 'data', 'library.json');

// تخزين حالة المستخدمين أثناء التنقل
const userState = new Map();

// =====================================
// التخصصات
// =====================================

const specialties = {
    mechanical: 'ميكانيكا',
    civil: 'مدنية',
    electrical: 'كهرباء',
    power: 'كهرباء - قدرة',
    communications: 'كهرباء - اتصالات'
};

// =====================================
// قراءة قاعدة البيانات
// =====================================

function loadLibrary() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return {
                mechanical: {},
                civil: {},
                electrical: {},
                power: {},
                communications: {}
            };
        }

        return JSON.parse(
            fs.readFileSync(DATA_FILE, 'utf8')
        );
    } catch (error) {
        console.error('خطأ في قراءة قاعدة البيانات:', error.message);
        return {};
    }
}

function saveLibrary(data) {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), {
            recursive: true
        });

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            'utf8'
        );

        return true;
    } catch (error) {
        console.error('خطأ في حفظ قاعدة البيانات:', error.message);
        return false;
    }
}

// =====================================
// إدارة حالة المستخدم
// =====================================

function getState(ctx) {
    return userState.get(ctx.from.id) || {};
}

function setState(ctx, values) {
    const oldState = getState(ctx);

    userState.set(ctx.from.id, {
        ...oldState,
        ...values
    });
}

function resetState(ctx) {
    userState.set(ctx.from.id, {
        step: 'main'
    });
}

// =====================================
// القوائم العامة
// =====================================

function mainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '📚 المحتوى الأكاديمي',
                'academic'
            )
        ],
        [
            Markup.button.callback(
                'ℹ️ معلومات المكتبة',
                'library_info'
            )
        ],
        [
            Markup.button.callback(
                '🔍 البحث عن مقرر',
                'search_course'
            )
        ],
        [
            Markup.button.callback(
                '📩 التواصل مع الإدارة',
                'contact'
            )
        ]
    ]);
}

function homeKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '🏠 القائمة الرئيسية',
                'main'
            )
        ]
    ]);
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
// القائمة الرئيسية
// =====================================

async function showMain(ctx, edit) {
    const message =
        '🎓 مرحباً بك في المكتبة الإلكترونية\n\n' +
        '🏛️ جامعة كسلا - كلية الهندسة\n\n' +
        'أهلاً بك عزيزي الطالب!\n\n' +
        'يمكنك من هنا الوصول إلى المقررات الدراسية، ' +
        'المحاضرات، الملخصات والامتحانات السابقة.\n\n' +
        'اختر الخدمة التي تريدها:';

    if (edit) {
        await safeEdit(ctx, message, mainKeyboard());
    } else {
        await ctx.reply(message, mainKeyboard());
    }
}

bot.start(async (ctx) => {
    resetState(ctx);
    await showMain(ctx, false);
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        '📚 مرحباً بك في المكتبة الإلكترونية.\n\n' +
        'استخدم الأزرار للتنقل بين التخصصات والمقررات.\n' +
        'أرسل /start للعودة إلى البداية.'
    );
});

bot.action('main', async (ctx) => {
    await ctx.answerCbQuery();

    resetState(ctx);

    await showMain(ctx, true);
});

// =====================================
// المحتوى الأكاديمي
// =====================================

bot.action('academic', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        step: 'specialty',
        specialty: null,
        subSpecialty: null,
        level: null,
        semester: null,
        courseId: null
    });

    await safeEdit(
        ctx,
        '📚 المحتوى الأكاديمي\n\n' +
        'اختر تخصصك الدراسي:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '⚙️ ميكانيكا',
                    'spec_mechanical'
                )
            ],
            [
                Markup.button.callback(
                    '🏗️ مدنية',
                    'spec_civil'
                )
            ],
            [
                Markup.button.callback(
                    '⚡ كهرباء',
                    'spec_electrical'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
});

// =====================================
// اختيار التخصص
// =====================================

function showLevelButtons() {
    const buttons = [];

    for (let level = 1; level <= 5; level++) {
        buttons.push([
            Markup.button.callback(
                'المستوى ' + level,
                'level_' + level
            )
        ]);
    }

    buttons.push([
        Markup.button.callback(
            '🔙 تغيير التخصص',
            'academic'
        )
    ]);

    return Markup.inlineKeyboard(buttons);
}

bot.action('spec_mechanical', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        specialty: 'mechanical',
        specialtyName: 'ميكانيكا',
        subSpecialty: null,
        step: 'level'
    });

    await safeEdit(
        ctx,
        '⚙️ تخصص الهندسة الميكانيكية\n\n' +
        'اختر المستوى الدراسي:',
        showLevelButtons()
    );
});

bot.action('spec_civil', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        specialty: 'civil',
        specialtyName: 'مدنية',
        subSpecialty: null,
        step: 'level'
    });

    await safeEdit(
        ctx,
        '🏗️ تخصص الهندسة المدنية\n\n' +
        'اختر المستوى الدراسي:',
        showLevelButtons()
    );
});

bot.action('spec_electrical', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        specialty: 'electrical',
        specialtyName: 'كهرباء',
        subSpecialty: null,
        step: 'level'
    });

    await safeEdit(
        ctx,
        '⚡ تخصص الهندسة الكهربائية\n\n' +
        'المستويات الأول والثاني والثالث مشتركة.\n' +
        'يبدأ اختيار التخصص الفرعي من المستوى الرابع.\n\n' +
        'اختر المستوى الدراسي:',
        showLevelButtons()
    );
});

// =====================================
// اختيار المستوى
// =====================================

bot.action(/^level_([1-5])$/, async (ctx) => {
    await ctx.answerCbQuery();

    const level = Number(ctx.match[1]);
    const state = getState(ctx);

    if (!state.specialty) {
        await ctx.reply('يرجى اختيار التخصص أولاً.');
        return;
    }

    setState(ctx, {
        level: level,
        semester: null,
        courseId: null,
        subSpecialty: null
    });

    // الكهرباء: المستويان الرابع والخامس يتفرعان
    if (
        state.specialty === 'electrical' &&
        level >= 4
    ) {
        setState(ctx, {
            step: 'sub_specialty'
        });

        await safeEdit(
            ctx,
            '⚡ الهندسة الكهربائية\n\n' +
            'المستوى ' + level + '\n\n' +
            'اختر التخصص الفرعي:',
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '⚡ قدرة',
                        'sub_power'
                    )
                ],
                [
                    Markup.button.callback(
                        '📡 اتصالات',
                        'sub_communications'
                    )
                ],
                [
                    Markup.button.callback(
                        '🔙 تغيير المستوى',
                        'academic'
                    )
                ]
            ])
        );

        return;
    }

    // بقية التخصصات والمستويات
    setState(ctx, {
        step: 'semester'
    });

    await showSemesterMenu(ctx);
});

// =====================================
// اختيار التخصص الفرعي للكهرباء
// =====================================

bot.action('sub_power', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        specialty: 'power',
        specialtyName: 'كهرباء - قدرة',
        subSpecialty: 'power',
        step: 'semester'
    });

    await showSemesterMenu(ctx);
});

bot.action('sub_communications', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        specialty: 'communications',
        specialtyName: 'كهرباء - اتصالات',
        subSpecialty: 'communications',
        step: 'semester'
    });

    await showSemesterMenu(ctx);
});

// =====================================
// قائمة الفصول الدراسية
// =====================================

async function showSemesterMenu(ctx) {
    const state = getState(ctx);

    await safeEdit(
        ctx,
        '📚 اختيار الفصل الدراسي\n\n' +
        'التخصص: ' + state.specialtyName + '\n' +
        'المستوى: ' + state.level + '\n\n' +
        'اختر الفصل الدراسي:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📘 الفصل الأول',
                    'semester_1'
                )
            ],
            [
                Markup.button.callback(
                    '📗 الفصل الثاني',
                    'semester_2'
                )
            ],
            [
                Markup.button.callback(
                    '🔙 تغيير المستوى',
                    'academic'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
}

// =====================================
// قراءة مقررات الفصل
// =====================================

function getCourses(state) {
    const library = loadLibrary();

    if (
        !state.specialty ||
        !state.level ||
        !state.semester
    ) {
        return {};
    }

    const specialtyData = library[state.specialty] || {};
    const levelData = specialtyData[String(state.level)] || {};
    const semesterData = levelData[String(state.semester)] || {};

    return semesterData;
}

// =====================================
// عرض المقررات
// =====================================

async function showCourses(ctx) {
    const state = getState(ctx);
    const courses = getCourses(state);

    const courseEntries = Object.entries(courses);

    if (courseEntries.length === 0) {
        await safeEdit(
            ctx,
            '📂 لا توجد مقررات مضافة لهذا الفصل حالياً.\n\n' +
            'يمكنك الرجوع واختيار فصل آخر.',
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '🔙 تغيير الفصل',
                        'back_semester'
                    )
                ],
                [
                    Markup.button.callback(
                        '🏠 الرئيسية',
                        'main'
                    )
                ]
            ])
        );

        return;
    }

    const buttons = courseEntries.map(([id, course]) => [
        Markup.button.callback(
            course.name,
            'course_' + id
        )
    ]);

    buttons.push([
        Markup.button.callback(
            '🔙 تغيير الفصل',
            'back_semester'
        )
    ]);

    buttons.push([
        Markup.button.callback(
            '🏠 الرئيسية',
            'main'
        )
    ]);

    await safeEdit(
        ctx,
        '📚 المقررات الدراسية\n\n' +
        'التخصص: ' + state.specialtyName + '\n' +
        'المستوى: ' + state.level + '\n' +
        'الفصل: ' + state.semester + '\n\n' +
        'اختر المقرر:',
        Markup.inlineKeyboard(buttons)
    );
}

bot.action(/^semester_([12])$/, async (ctx) => {
    await ctx.answerCbQuery();

    const semester = Number(ctx.match[1]);

    const state = getState(ctx);

    if (!state.specialty || !state.level) {
        await ctx.reply('يرجى اختيار التخصص والمستوى أولاً.');
        return;
    }

    setState(ctx, {
        semester: semester,
        step: 'courses'
    });

    await showCourses(ctx);
});

bot.action('back_semester', async (ctx) => {
    await ctx.answerCbQuery();

    await showSemesterMenu(ctx);
});

// =====================================
// اختيار مقرر
// =====================================

bot.action(/^course_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const courseId = ctx.match[1];
    const state = getState(ctx);
    const courses = getCourses(state);
    const course = courses[courseId];

    if (!course) {
        await ctx.reply(
            'تعذر العثور على المقرر. يرجى العودة إلى قائمة المقررات.'
        );
        return;
    }

    setState(ctx, {
        courseId: courseId,
        courseName: course.name,
        step: 'course_files'
    });

    await safeEdit(
        ctx,
        '📘 المقرر: ' + course.name + '\n\n' +
        'اختر نوع المحتوى الذي تريد الوصول إليه:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📚 المحاضرات',
                    'files_lectures'
                )
            ],
            [
                Markup.button.callback(
                    '📝 الامتحانات السابقة',
                    'files_exams'
                )
            ],
            [
                Markup.button.callback(
                    '📑 الملخصات',
                    'files_summaries'
                )
            ],
            [
                Markup.button.callback(
                    '🔙 المقررات',
                    'back_courses'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
});

bot.action('back_courses', async (ctx) => {
    await ctx.answerCbQuery();

    await showCourses(ctx);
});

// =====================================
// إرسال ملفات PDF
// =====================================

const contentTypes = {
    lectures: 'المحاضرات',
    exams: 'الامتحانات السابقة',
    summaries: 'الملخصات'
};

for (const [key, label] of Object.entries(contentTypes)) {
    bot.action('files_' + key, async (ctx) => {
        await ctx.answerCbQuery();

        const state = getState(ctx);
        const courses = getCourses(state);
        const course = courses[state.courseId];

        if (!course) {
            await ctx.reply('لم أتمكن من العثور على المقرر.');
            return;
        }

        const files = course[key] || [];

        if (files.length === 0) {
            await ctx.reply(
                '📂 لا توجد ملفات في قسم ' + label +
                ' لمقرر ' + course.name + ' حتى الآن.',
                Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            '🔙 العودة للمقرر',
                            'back_course'
                        )
                    ],
                    [
                        Markup.button.callback(
                            '🏠 الرئيسية',
                            'main'
                        )
                    ]
                ])
            );

            return;
        }

        await ctx.reply(
            '📂 ' + label + '\n' +
            '📘 المقرر: ' + course.name
        );

        for (const file of files) {
            try {
                const caption = file.title || course.name;

                if (file.file_id) {
                    await ctx.replyWithDocument(
                        file.file_id,
                        { caption: caption }
                    );
                } else if (file.url) {
                    await ctx.replyWithDocument(
                        {
                            url: file.url,
                            filename: file.filename || 'document.pdf'
                        },
                        { caption: caption }
                    );
                } else {
                    await ctx.reply(
                        'الملف لا يحتوي على رابط أو file_id صالح.'
                    );
                }
            } catch (error) {
                console.error(
                    'خطأ في إرسال الملف:',
                    error.message
                );

                await ctx.reply(
                    'تعذر إرسال الملف: ' +
                    (file.title || file.filename || 'PDF')
                );
            }
        }

        await ctx.reply(
            'انتهى عرض الملفات.',
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '🔙 العودة للمقرر',
                        'back_course'
                    )
                ],
                [
                    Markup.button.callback(
                        '🏠 الرئيسية',
                        'main'
                    )
                ]
            ])
        );
    });
}

bot.action('back_course', async (ctx) => {
    await ctx.answerCbQuery();

    const state = getState(ctx);
    const courses = getCourses(state);
    const course = courses[state.courseId];

    if (!course) {
        await showCourses(ctx);
        return;
    }

    await safeEdit(
        ctx,
        '📘 المقرر: ' + course.name + '\n\n' +
        'اختر نوع المحتوى:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📚 المحاضرات',
                    'files_lectures'
                )
            ],
            [
                Markup.button.callback(
                    '📝 الامتحانات',
                    'files_exams'
                )
            ],
            [
                Markup.button.callback(
                    '📑 الملخصات',
                    'files_summaries'
                )
            ],
            [
                Markup.button.callback(
                    '🔙 المقررات',
                    'back_courses'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
});

// =====================================
// البحث عن مقرر
// =====================================

bot.action('search_course', async (ctx) => {
    await ctx.answerCbQuery();

    setState(ctx, {
        step: 'search'
    });

    await ctx.reply(
        '🔍 البحث عن مقرر\n\n' +
        'أرسل اسم المقرر الذي تبحث عنه.\n\n' +
        'مثال: الديناميكا الحرارية'
    );
});

function searchCourses(query) {
    const library = loadLibrary();
    const results = [];
    const normalizedQuery = query.trim().toLowerCase();

    for (const [specialty, levels] of Object.entries(library)) {
        for (const [level, semesters] of Object.entries(levels || {})) {
            for (const [semester, courses] of Object.entries(semesters || {})) {
                for (const [id, course] of Object.entries(courses || {})) {
                    if (
                        course.name &&
                        course.name.toLowerCase().includes(normalizedQuery)
                    ) {
                        results.push({
                            specialty: specialty,
                            level: level,
                            semester: semester,
                            id: id,
                            name: course.name
                        });
                    }
                }
            }
        }
    }

    return results;
}

bot.on('text', async (ctx) => {
    const state = getState(ctx);

    if (state.step !== 'search') {
        return;
    }

    const query = ctx.message.text.trim();

    if (!query) {
        await ctx.reply('يرجى كتابة اسم المقرر.');
        return;
    }

    const results = searchCourses(query);

    if (results.length === 0) {
        setState(ctx, { step: 'main' });

        await ctx.reply(
            'لم يتم العثور على مقرر بهذا الاسم.\n' +
            'حاول استخدام اسم مختلف.',
            mainKeyboard()
        );

        return;
    }

    const visibleResults = results.slice(0, 20);

    setState(ctx, {
        step: 'search_results',
        searchResults: visibleResults
    });

    const buttons = visibleResults.map((item, index) => [
        Markup.button.callback(
            item.name + ' — مستوى ' + item.level,
            'search_result_' + index
        )
    ]);

    buttons.push([
        Markup.button.callback(
            '🏠 الرئيسية',
            'main'
        )
    ]);

    await ctx.reply(
        '🔎 نتائج البحث: ' + results.length + '\n\n' +
        'اختر المقرر:',
        Markup.inlineKeyboard(buttons)
    );
});

bot.action(/^search_result_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const state = getState(ctx);
    const index = Number(ctx.match[1]);
    const item = (state.searchResults || [])[index];

    if (!item) {
        await ctx.reply(
            'انتهت صلاحية نتيجة البحث. أعد البحث من جديد.'
        );
        return;
    }

    const library = loadLibrary();

    const course =
        library[item.specialty] &&
        library[item.specialty][item.level] &&
        library[item.specialty][item.level][item.semester] &&
        library[item.specialty][item.level][item.semester][item.id];

    if (!course) {
        await ctx.reply('تعذر العثور على المقرر.');
        return;
    }

    setState(ctx, {
        specialty: item.specialty,
        specialtyName: specialties[item.specialty] || item.specialty,
        level: Number(item.level),
        semester: Number(item.semester),
        courseId: item.id,
        courseName: course.name,
        step: 'course_files'
    });

    await safeEdit(
        ctx,
        '📘 المقرر: ' + course.name + '\n\n' +
        'اختر نوع المحتوى:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📚 المحاضرات',
                    'files_lectures'
                )
            ],
            [
                Markup.button.callback(
                    '📝 الامتحانات',
                    'files_exams'
                )
            ],
            [
                Markup.button.callback(
                    '📑 الملخصات',
                    'files_summaries'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
});

// =====================================
// معلومات المكتبة
// =====================================

bot.action('library_info', async (ctx) => {
    await ctx.answerCbQuery();

    await safeEdit(
        ctx,
        'ℹ️ المكتبة الإلكترونية\n\n' +
        '🏛️ جامعة كسلا - كلية الهندسة\n\n' +
        'تهدف المكتبة إلى تسهيل الوصول إلى المواد الأكاديمية، ' +
        'بما في ذلك المحاضرات والملخصات والامتحانات السابقة.\n\n' +
        'يتم تنظيم المحتوى حسب التخصص والمستوى والفصل الدراسي.\n\n' +
        'توفر الملفات يعتمد على ما تتم إضافته إلى المكتبة.',
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📚 تصفح المحتوى',
                    'academic'
                )
            ],
            [
                Markup.button.callback(
                    '🏠 الرئيسية',
                    'main'
                )
            ]
        ])
    );
});

// =====================================
// التواصل مع الإدارة
// =====================================

bot.action('contact', async (ctx) => {
    await ctx.answerCbQuery();

    await safeEdit(
        ctx,
        '📩 التواصل مع إدارة المكتبة\n\n' +
        'لم يتم تحديد حساب المسؤول بعد.\n\n' +
        'يمكن إضافة اسم المستخدم الخاص بالإدارة لاحقاً.',
        homeKeyboard()
    );
});

// =====================================
// معالجة الأخطاء
// =====================================

bot.catch((error, ctx) => {
    console.error(
        'حدث خطأ أثناء معالجة التحديث:',
        error.message
    );
});

// =====================================
// تشغيل البوت
// =====================================

bot.launch()
    .then(() => {
        console.log('Telegram bot started successfully');
    })
    .catch((error) => {
        console.error(
            'Failed to start Telegram bot:',
            error.message
        );
    });

process.once('SIGINT', () => {
    bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
});
