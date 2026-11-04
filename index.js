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

const bot = new Telegraf(TOKEN);
const app = express();

app.use(express.json());

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
            return data.result.online; // true, якщо розетка на зв'язку (є світло), false — якщо офлайн[cite: 1]
        }
        return false;
    } catch (error) {
        console.error('Помилка запиту до Tuya:', error);
        return false;
    }
}

// Команда /start з перевіркою доступу
bot.start((ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Вибачте, цей бот приватний.');
    }

    ctx.reply(
        'Привіт! Натисни кнопку нижче, щоб перевірити, чи є вдома світло.',
        Markup.keyboard([['💡 Перевірити світло вдома']]).resize()
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