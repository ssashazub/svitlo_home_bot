const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Токен твого бота та твій Telegram ID
const TOKEN = "9162787820:AAGRrLMHNvkJJ7XarTyoWsCcUhXRUt3j9s0";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

// Список користувачів, яким дозволено користуватися ботом
const ALLOWED_USERS = [350523892];

// Дані Tuya / Smart Life (розетка "Напруга дома")
const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID;
const TUYA_SECRET = process.env.TUYA_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID || 'bff0b6603044b5be61heq2';
const REGION = process.env.TUYA_REGION || 'eu';

// Адреса для графіка YASNO (Київ, вул. Анни Ахматової, 13Д)
const YASNO_REGION_ID = 25;
const YASNO_DSO_ID = 902;
const YASNO_STREET = process.env.YASNO_STREET || 'вул. Ахматової Анни';
const YASNO_HOUSE = process.env.YASNO_HOUSE || '13Д';
const YASNO_ADDRESS_LABEL = process.env.YASNO_ADDRESS_LABEL || 'вул. Анни Ахматової, 13Д';
const YASNO_API = 'https://app.yasno.ua/api/blackout-service/public';

const bot = new Telegraf(TOKEN);
const app = express();

app.use(express.json());

let lastYasnoHash = null;
let cachedYasnoGroup = null;
let lastPowerStatus = null;

const YASNO_HEADERS = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// Перевірка статусу розетки Smart Life / Tuya API
async function getSmartLifeStatus() {
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
        if (data.success && data.result) {
            return data.result.online; // true, якщо розетка на зв'язку з хмарою
        }
        return false;
    } catch (error) {
        console.error('Помилка запиту до Smart Life (Tuya):', error);
        return false;
    }
}

function minutesToTime(minutes) {
    const total = Math.max(0, Math.min(1440, Number(minutes) || 0));
    const hh = Math.floor(total / 60) % 24;
    const mm = total % 60;
    if (total === 1440) return '24:00';
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatDayDate(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate);
    return d.toLocaleDateString('uk-UA', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        timeZone: 'Europe/Kyiv'
    });
}

function formatUpdatedOn(isoDate) {
    if (!isoDate) return '';
    return new Date(isoDate).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
}

function statusLabel(status) {
    switch (status) {
        case 'EmergencyShutdowns':
            return '⚠️ Зараз аварійні відключення (плановий графік може не діяти)';
        case 'WaitingForSchedule':
            return '⏳ Графік очікує підтвердження / може змінитись';
        case 'ScheduleApplies':
            return '✅ Діє підтверджений графік';
        default:
            return status ? `ℹ️ Статус: ${status}` : '';
    }
}

function formatSlots(slots) {
    if (!Array.isArray(slots) || slots.length === 0) {
        return 'Немає опублікованих слотів.';
    }

    const outages = slots.filter((s) => {
        const type = String(s.type || '').toLowerCase();
        return type.includes('definite') || type.includes('outage');
    });

    if (outages.length === 0) {
        return '🟢 Відключень за графіком немає.';
    }

    const sorted = outages
        .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
        .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const slot of sorted) {
        const last = merged[merged.length - 1];
        if (last && slot.start <= last.end) {
            last.end = Math.max(last.end, slot.end);
        } else {
            merged.push({ ...slot });
        }
    }

    return merged
        .map((s) => `🔴 ${minutesToTime(s.start)} – ${minutesToTime(s.end)}`)
        .join('\n');
}

function formatDayBlock(title, day) {
    if (!day) return `*${title}:*\nДані відсутні.`;

    const lines = [
        `*${title} (${formatDayDate(day.date)})*`,
        statusLabel(day.status)
    ].filter(Boolean);

    if (day.status === 'EmergencyShutdowns' && (!day.slots || day.slots.length === 0)) {
        lines.push('Планові інтервали не опубліковані.');
    } else {
        lines.push(formatSlots(day.slots));
    }

    return lines.join('\n');
}

async function yasnoGet(path) {
    const response = await fetch(`${YASNO_API}${path}`, { headers: YASNO_HEADERS });
    if (!response.ok) {
        throw new Error(`YASNO HTTP ${response.status} for ${path}`);
    }
    return response.json();
}

async function resolveYasnoGroup() {
    if (cachedYasnoGroup) return cachedYasnoGroup;

    const streetQuery = YASNO_STREET.replace(/^вул\.\s*/i, '').split(/\s+/)[0] || YASNO_STREET;
    const streets = await yasnoGet(
        `/shutdowns/addresses/v2/streets?regionId=${YASNO_REGION_ID}&dsoId=${YASNO_DSO_ID}&query=${encodeURIComponent(streetQuery)}`
    );
    const street = (streets || []).find((s) =>
        String(s.value).toLowerCase().includes(streetQuery.toLowerCase())
    ) || (streets || [])[0];

    if (!street) {
        throw new Error('Street not found');
    }

    const houses = await yasnoGet(
        `/shutdowns/addresses/v2/houses?regionId=${YASNO_REGION_ID}&dsoId=${YASNO_DSO_ID}&streetId=${street.id}&query=${encodeURIComponent(YASNO_HOUSE)}`
    );
    const house = (houses || []).find((h) =>
        String(h.value).toLowerCase() === String(YASNO_HOUSE).toLowerCase()
    ) || (houses || []).find((h) =>
        String(h.value).toLowerCase().startsWith(String(YASNO_HOUSE).toLowerCase())
    );

    if (!house) {
        throw new Error('House not found');
    }

    const groupInfo = await yasnoGet(
        `/shutdowns/addresses/v2/group?regionId=${YASNO_REGION_ID}&dsoId=${YASNO_DSO_ID}&streetId=${street.id}&houseId=${house.id}`
    );

    cachedYasnoGroup = `${groupInfo.group}.${groupInfo.subgroup}`;
    return cachedYasnoGroup;
}

async function getYasnoSchedule() {
    try {
        const group = await resolveYasnoGroup();
        const data = await yasnoGet(
            `/shutdowns/regions/${YASNO_REGION_ID}/dsos/${YASNO_DSO_ID}/planned-outages`
        );

        const groupData = data[group];
        if (!groupData) {
            return {
                text: `⚠️ Групу ${group} не знайдено в графіку YASNO.`,
                hash: null
            };
        }

        const rawString = JSON.stringify(groupData);
        const currentHash = crypto.createHash('md5').update(rawString).digest('hex');

        let text =
            `📅 *Графік відключень YASNO*\n` +
            `📍 *Адреса:* ${YASNO_ADDRESS_LABEL}\n` +
            `🔢 *Група:* ${group}\n\n` +
            `${formatDayBlock('Сьогодні', groupData.today)}\n\n` +
            `${formatDayBlock('Завтра', groupData.tomorrow)}`;

        if (groupData.updatedOn) {
            text += `\n\n🕒 Оновлено: ${formatUpdatedOn(groupData.updatedOn)}`;
        }

        return { text: text.slice(0, 4000), hash: currentHash, group };
    } catch (error) {
        console.error('Помилка отримання графіка YASNO:', error);
        cachedYasnoGroup = null;
        return { text: '❌ Помилка з\'єднання з сервером графіків YASNO.', hash: null };
    }
}

// Фонова перевірка (статус розетки кожні 2 хвилини + оновлення YASNO)
setInterval(async () => {
    try {
        const isOnline = await getSmartLifeStatus();
        if (lastPowerStatus !== null && lastPowerStatus !== isOnline) {
            lastPowerStatus = isOnline;
            const alertText = isOnline
                ? '🟢 *Світло зʼявилося!* (Розетка в мережі)'
                : '🔴 *Світло зникло!* (Розетка офлайн)';

            for (const userId of ALLOWED_USERS) {
                await bot.telegram.sendMessage(userId, alertText, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
        if (lastPowerStatus === null) {
            lastPowerStatus = isOnline;
        }

        const result = await getYasnoSchedule();
        if (!result.hash) return;

        if (lastYasnoHash === null) {
            lastYasnoHash = result.hash;
            return;
        }

        if (result.hash !== lastYasnoHash) {
            lastYasnoHash = result.hash;
            const notificationText = `🔔 *Увага! Оновлено графік відключень для Ахматової, 13Д!*\n\n${result.text}`;

            for (const userId of ALLOWED_USERS) {
                await bot.telegram.sendMessage(userId, notificationText, { parse_mode: 'Markdown' }).catch((err) => {
                    console.error(`Не вдалося надіслати сповіщення користувачу ${userId}:`, err);
                });
            }
        }
    } catch (e) {
        console.error('Помилка у фоновій перевірці:', e);
    }
}, 2 * 60 * 1000);

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

bot.hears('💡 Перевірити світло вдома', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply("⏳ Перевіряю стан розетки...");
    const isOnline = await getSmartLifeStatus();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (isOnline) {
        ctx.reply('🟢 Світло є! (Розетка на звʼязку)');
    } else {
        ctx.reply('🔴 Світла немає! (Розетка офлайн)');
    }
});

bot.hears('📅 Графік YASNO', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.from.id)) {
        return ctx.reply('⛔ У вас немає доступу до цього бота.');
    }

    const loadingMsg = await ctx.reply('⏳ Завантажую графік для Ахматової, 13Д...');
    const result = await getYasnoSchedule();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.url('🌐 Офіційна сторінка YASNO', 'https://static.yasno.ua/kyiv/outages')]
    ]);

    ctx.reply(result.text, {
        parse_mode: 'Markdown',
        ...inlineKeyboard
    });
});

const PORT = process.env.PORT || 3000;

app.use(bot.webhookCallback(`/bot${TOKEN}`));

app.get('/', (req, res) => {
    res.send('Smart Life / Atorch Telegram Bot is running!');
});

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    if (WEBHOOK_URL) {
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${TOKEN}`);
        console.log(`Webhook set to ${WEBHOOK_URL}/bot${TOKEN}`);
    }
});