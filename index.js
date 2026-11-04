const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Токен твого бота та твій Telegram ID
const TOKEN = "9162787820:AAGRrLMHNvkJJ7XarTyoWsCcUhXRUt3j9s0";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL; // Render підставить автоматично

// Список користувачів, яким дозволено користуватися ботом (твій ID)
const ALLOWED_USERS = [350523892];

// Дані Tuya IoT (їх ти вкажеш у змінних середовища на Render.com)
const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID;
const TUYA_SECRET = process.env.TUYA_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;
const REGION = process.env.TUYA_REGION || 'eu';

// Група відключень YASNO (наприклад: '1', '2', '3', '4', '5', '6')
const YASNO_GROUP = process.env.YASNO_GROUP || '1';

const bot = new Telegraf(TOKEN);
const app = express();

app.use(express.json());

// Змінна для збереження попереднього стану графіка (щоб відстежувати оновлення)
let lastYasnoHash = null;

// Функція запиту до Tuya Cloud API для перевірки статусу розетки Atorch
async function getAtorchStatus() {
    try {
        const t = Date.now().toString();
        const clientId = TUYA_CLIENT_ID;
        const secret = TUYA_SECRET;

        const signUrl = `/v1.0/iot-03/devices/${DEVICE_ID}`;
        const stringToSign = `GET\n${crypto.createHash('sha256').update('').digest('hex')}\n\n${signUrl}`;
        const signStr = clientId + t + stringToSign;
        const sign = crypto.createHmac('sha256', secret).update(signStr).digest('hex').toUpperCase();

        const response = await fetch(`https://openapi.tuya${REGION}.com${signUrl}`, {
            method: 'GET',
            headers: {
                'client_id': clientId,
                't': t,
                'sign': sign,
                'sign_method': 'HMAC-SHA256'
            }
        });

        const data = await response.json();
        if (data.success) {
            return data.result.online;
        }
        return false;
    } catch (error) {
        console.error('Помилка запиту до Tuya:', error);
        return false;
    }
}

// Форматування тексту графіка YASNO
function formatYasnoData(data) {
    if (data && data.group && data.group[YASNO_GROUP]) {
        const groupSchedule = data.group[YASNO_GROUP];
        let text = `📅 **Графік YASNO (Група ${YASNO_GROUP}):**\n\n`;

        for (const [day, hours] of Object.entries(groupSchedule)) {
            text += `🗓 **${day}**:\n`;
            if (Array.isArray(hours) && hours.length > 0) {
                hours.forEach(h => {
                    text += `  • ${h.start} — ${h.end} (${h.type === 'DEFINITE_OUTAGE' ? '🔴 Відключення' : '🟡 Можливе відключення'})\n`;
                });
            } else {
                text += `  ✅ Відключень не заплановано\n`;
            }
            text += `\n`;
        }
        return text;
    }
    return `ℹ️ Актуальних графіків відключень для Групи ${YASNO_GROUP} наразі немає або мережа працює без обмежень.`;
}

// Функція отримання графіка від YASNO
async function getYasnoSchedule() {
    try {
        const response = await fetch('https://static.yasno.ua/kyiv/outages', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        if (!response.ok) {
            return { text: '⚠️ Не вдалося отримати дані від YASNO.', hash: null, raw: null };
        }

        const data = await response.json();
        const rawString = JSON.stringify(data.group?.[YASNO_GROUP] || {});
        const currentHash = crypto.createHash('md5').update(rawString).digest('hex');

        return {
            text: formatYasnoData(data),
            hash: currentHash,
            raw: data
        };
    } catch (error) {
        console.error('Помилка запиту до YASNO:', error);
        return { text: '❌ Помилка під час отримання графіка YASNO.', hash: null, raw: null };
    }
}

// Фонова перевірка оновлень графіків (кожні 10 хвилин)
setInterval(async () => {
    try {
        const result = await getYasnoSchedule();
        if (!result.hash) return;

        // Якщо це перша перевірка після запуску — просто запам'ятовуємо хеш
        if (lastYasnoHash === null) {
            lastYasnoHash = result.hash;
            return;
        }

        // Якщо хеш змінився — графік оновився! Надсилаємо сповіщення всім дозволеним користувачам
        if (result.hash !== lastYasnoHash) {
            lastYasnoHash = result.hash;
            const notificationText = `🔔 **Увага! Оновлено графік відключень YASNO!**\n\n${result.text}`;

            for (const userId of ALLOWED_USERS) {
                await bot.telegram.sendMessage(userId, notificationText, { parse_mode: 'Markdown' }).catch((err) => {
                    console.error(`Не вдалося надіслати сповіщення користувачу ${userId}:`, err);
                });
            }
        }
    } catch (e) {
        console.error('Помилка у фоновій перевірці YASNO:', e);
    }
}, 10 * 60 * 1000); // 10 хвилин

// Команда /start з перевіркою доступу
bot.start((ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Вибачте, цей бот приватний.');
    }

    ctx.reply(
        'Привіт! Натисни кнопку нижче, щоб перевірити світло або дізнатися графік.',
        Markup.keyboard([
            ['💡 Перевірити світло вдома'],
            ['📅 Графік YASNO']
        ]).resize()
    );
});

// Обробка натискання на кнопку перевірки світла
bot.hears('💡 Перевірити світло вдома', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply('⏳ Перевіряю стан...');
    const isOnline = await getAtorchStatus();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (isOnline) {
        ctx.reply('🟢 Світло є!');
    } else {
        ctx.reply('🔴 Світла немає!');
    }
});

// Обробка натискання на кнопку графіків YASNO
bot.hears('📅 Графік YASNO', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply('⏳ Завантажую актуальний графік YASNO...');
    const result = await getYasnoSchedule();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    ctx.reply(result.text, { parse_mode: 'Markdown' });
});

const PORT = process.env.PORT || 3000;

app.use(bot.webhookCallback(`/bot${TOKEN}`));

app.get('/', (req, res) => {
    res.send('Atorch Telegram Bot is running!');
});

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    if (WEBHOOK_URL) {
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${TOKEN}`);
        console.log(`Webhook set to ${WEBHOOK_URL}/bot${TOKEN}`);
    }
});