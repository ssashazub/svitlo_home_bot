const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Токен твого бота та твій Telegram ID
const TOKEN = "9162787820:AAGRrLMHNvkJJ7XarTyoWsCcUhXRUt3j9s0";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

// Список користувачів, яким дозволено користуватися ботом
const ALLOWED_USERS = [350523892];

// Дані Tuya IoT
const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID;
const TUYA_SECRET = process.env.TUYA_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;
const REGION = process.env.TUYA_REGION || 'eu';

// Група відключень YASNO / ДТЕК (наприклад: '1', '2', '3', '4', '5', '6')
const YASNO_GROUP = process.env.YASNO_GROUP || '1';

const bot = new Telegraf(TOKEN);
const app = express();

app.use(express.json());

let lastYasnoHash = null;

// Перевірка статусу розетки Atorch через Tuya API
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

// Отримання графіка через джерело/API ДТЕК (на основі напрацювань dtek-schedule)
async function getYasnoSchedule() {
    try {
        // Запит до публічного ендпоінта графіків ДТЕК/Київські електромережі
        const response = await fetch(`https://www.dtek-kem.com.ua/ua/ajax`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: `city=kyiv&group=${YASNO_GROUP}`
        });

        if (!response.ok) {
            return { text: '⚠️ Не вдалося отримати графік від ДТЕК.', hash: null };
        }

        const data = await response.json();
        const rawString = JSON.stringify(data);
        const currentHash = crypto.createHash('md5').update(rawString).digest('hex');

        let text = `📅 **Графік відключень (Група ${YASNO_GROUP}):**\n📍 *Адреса:* вул. Анни Ахматової, 13Д\n\n`;

        // Якщо сервер повернув HTML-розвітку або масив годин
        if (data.pages && typeof data.pages === 'string') {
            // Очищаємо базові HTML теги для зручного читання в Telegram, якщо це верстка
            text += data.pages.replace(/<[^>]*>?/gm, '');
        } else if (data.content) {
            text += data.content.replace(/<[^>]*>?/gm, '');
        } else {
            text += `ℹ️ Графік оновлено, але форматується через веб-сайт. Переглянь деталі нижче.`;
        }

        return { text: text.slice(0, 4000), hash: currentHash };

    } catch (error) {
        console.error('Помилка отримання графіка ДТЕК:', error);
        return { text: '❌ Помилка з\'єднання з сервером графіків ДТЕК.', hash: null };
    }
}

// Фонова перевірка оновлень графіка (кожні 10 хвилин)
setInterval(async () => {
    try {
        const result = await getYasnoSchedule();
        if (!result.hash) return;

        if (lastYasnoHash === null) {
            lastYasnoHash = result.hash;
            return;
        }

        if (result.hash !== lastYasnoHash) {
            lastYasnoHash = result.hash;
            const notificationText = `🔔 **Увага! Оновлено графік відключень для Ахматової, 13Д!**\n\n${result.text}`;

            for (const userId of ALLOWED_USERS) {
                await bot.telegram.sendMessage(userId, notificationText, { parse_mode: 'Markdown' }).catch((err) => {
                    console.error(`Не вдалося надіслати сповіщення користувачу ${userId}:`, err);
                });
            }
        }
    } catch (e) {
        console.error('Помилка у фоновій перевірці:', e);
    }
}, 10 * 60 * 1000);

// Команда /start
bot.start((ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Вибачте, цей бот приватний.');
    }

    ctx.reply(
        'Привіт! Оберіть потрібну дію на клавіатурі нижче:',
        Markup.keyboard([
            ['💡 Перевірити світло вдома'],
            ['📅 Графік YASNO']
        ]).resize()
    );
});

// Кнопка перевірки світла через розетку
bot.hears('💡 Перевірити світло вдома', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply('⏳ Перевіряю стан...');
    const isOnline = await getAtorchStatus();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (isOnline) {
        ctx.reply('🟢 Світло є! (Розетка в мережі)');
    } else {
        ctx.reply('🔴 Світла немає! (Розетка офлайн)');
    }
});

// Кнопка перегляду графіка
bot.hears('📅 Графік YASNO', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply('⏳ Завантажую графік для Ахматової, 13Д...');
    const result = await getYasnoSchedule();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.url('🌐 Офіційна сторінка YASNO', 'https://yasno.com.ua/ru/schedule-kyiv')]
    ]);

    ctx.reply(result.text, {
        parse_mode: 'Markdown',
        ...inlineKeyboard
    });
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