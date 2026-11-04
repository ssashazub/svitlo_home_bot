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

// Група відключень YASNO (наприклад: '1', '2', '3', '4', '5', '6')
const YASNO_GROUP = process.env.YASNO_GROUP || '1';

const bot = new Telegraf(TOKEN);
const app = express();

app.use(express.json());

let lastYasnoHash = null;

// Функція перевірки статусу розетки Atorch
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

// Функція парсингу та форматування графіків YASNO для Києва
async function getYasnoSchedule() {
    try {
        // Використовуємо актуальний API endpoint YASNO для Києва
        const response = await fetch(`https://yasno.com.ua/api/kyiv/outages?group=${YASNO_GROUP}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            return { text: '⚠️ Не вдалося отримати дані від YASNO. Спробуй пізніше.', hash: null };
        }

        const data = await response.json();

        // Перевіряємо структуру відповіді API YASNO
        // Зазвичай структура містить масив днів або об'єкт із графіком
        if (!data || !data.schedule) {
            // Альтернативний формат перевірки структури, якщо дані прийшли інакше
            const rawString = JSON.stringify(data);
            const currentHash = crypto.createHash('md5').update(rawString).digest('hex');

            return {
                text: `📅 **Графік YASNO (Група ${YASNO_GROUP}):**\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 3500)}\n\`\`\``,
                hash: currentHash
            };
        }

        let text = `📅 **Графік відключень YASNO (Група ${YASNO_GROUP}):**\n\n`;

        // Форматуємо дні та години з отриманого об'єкта
        for (const dayItem of data.schedule) {
            text += `🗓 **${dayItem.date || 'День'}**:\n`;
            if (dayItem.slots && dayItem.slots.length > 0) {
                dayItem.slots.forEach(slot => {
                    const statusIcon = slot.type === 'outage' ? '🔴' : '🟡';
                    text += `  • ${slot.start} — ${slot.end} (${statusIcon} ${slot.type === 'outage' ? 'Відключення' : 'Можливе відключення'})\n`;
                });
            } else {
                text += `  ✅ Відключень за цим днем немає\n`;
            }
            text += `\n`;
        }

        const rawString = JSON.stringify(data);
        const currentHash = crypto.createHash('md5').update(rawString).digest('hex');

        return { text, hash: currentHash };

    } catch (error) {
        console.error('Помилка запиту до YASNO API:', error);
        return { text: '❌ Помилка обробки графіка YASNO.', hash: null };
    }
}

// Фонова перевірка оновлень графіків (кожні 10 хвилин)
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
}, 10 * 60 * 1000);

// Команда /start
bot.start((ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Вибачте, цей бот приватний.');
    }

    ctx.reply(
        'Привіт! Натисни кнопку нижче, щоб перевірити світло або переглянути графік.',
        Markup.keyboard([
            ['💡 Перевірити світло вдома'],
            ['📅 Графік YASNO']
        ]).resize()
    );
});

// Перевірка світла через розетку
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

// Запит графіка по кнопці
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