const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Токен твого бота та твій Telegram ID
const TOKEN = "9162787820:AAGRrLMHNvkJJ7XarTyoWsCcUhXRUt3j9s0";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

// Адміни керують інвайтами. Доступ — лише за запрошенням.
const ADMIN_IDS = (process.env.ADMIN_IDS || '350523892')
    .split(',')
    .map((id) => Number(String(id).trim()))
    .filter(Boolean);

// Запрошені юзери, які НЕ злітають після редеплою. Приклад: MEMBER_IDS=111,222
const MEMBER_IDS = (process.env.MEMBER_IDS || '')
    .split(',')
    .map((id) => Number(String(id).trim()))
    .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');

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

const YASNO_STATE_FILE = path.join(DATA_DIR, 'yasno-state.json');
const YASNO_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

function loadYasnoState() {
    try {
        if (fs.existsSync(YASNO_STATE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(YASNO_STATE_FILE, 'utf8'));
            return {
                lastHash: parsed.lastHash || null,
                lastNotifiedHash: parsed.lastNotifiedHash || null,
                lastUpdatedOn: parsed.lastUpdatedOn || null,
                lastNotifiedUpdatedOn: parsed.lastNotifiedUpdatedOn || null,
                lastNotifyAt: Number(parsed.lastNotifyAt) || 0
            };
        }
    } catch (error) {
        console.error('Не вдалося прочитати yasno-state.json:', error.message || error);
    }
    return {
        lastHash: null,
        lastNotifiedHash: null,
        lastUpdatedOn: null,
        lastNotifiedUpdatedOn: null,
        lastNotifyAt: 0
    };
}

function saveYasnoState(state) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(YASNO_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('Не вдалося зберегти yasno-state.json:', error.message || error);
    }
}

function yasnoStateSnapshot() {
    return {
        lastHash: lastYasnoHash,
        lastNotifiedHash: lastYasnoNotifiedHash,
        lastUpdatedOn: lastYasnoUpdatedOn,
        lastNotifiedUpdatedOn: lastYasnoNotifiedUpdatedOn,
        lastNotifyAt: lastYasnoNotifyAt
    };
}

function persistYasnoState() {
    saveYasnoState(yasnoStateSnapshot());
}

/** Зливає диск + пам'ять: cooldown/updatedOn ніколи не відкочуються назад у межах процесу. */
function mergeYasnoStateFromDisk() {
    const disk = loadYasnoState();
    const diskNotifyAt = Number(disk.lastNotifyAt) || 0;
    const memNotifyAt = Number(lastYasnoNotifyAt) || 0;

    if (diskNotifyAt > memNotifyAt) {
        lastYasnoNotifyAt = diskNotifyAt;
        lastYasnoHash = disk.lastHash || lastYasnoHash;
        lastYasnoNotifiedHash = disk.lastNotifiedHash || lastYasnoNotifiedHash;
        lastYasnoUpdatedOn = disk.lastUpdatedOn || lastYasnoUpdatedOn;
        lastYasnoNotifiedUpdatedOn = disk.lastNotifiedUpdatedOn || lastYasnoNotifiedUpdatedOn;
        return;
    }

    if (diskNotifyAt === memNotifyAt) {
        lastYasnoHash = disk.lastHash || lastYasnoHash;
        lastYasnoNotifiedHash = disk.lastNotifiedHash || lastYasnoNotifiedHash;
        lastYasnoUpdatedOn = disk.lastUpdatedOn || lastYasnoUpdatedOn;
        lastYasnoNotifiedUpdatedOn = disk.lastNotifiedUpdatedOn || lastYasnoNotifiedUpdatedOn;
        return;
    }

    // Пам'ять свіжіша за диск (ефемерний FS / невдалий save) — лишаємо memory.
}

function isYasnoNotifyCooldownActive(now = Date.now()) {
    return lastYasnoNotifyAt > 0 && now - lastYasnoNotifyAt < YASNO_NOTIFY_COOLDOWN_MS;
}

let yasnoState = loadYasnoState();
let lastYasnoHash = yasnoState.lastHash;
let lastYasnoNotifiedHash = yasnoState.lastNotifiedHash;
let lastYasnoUpdatedOn = yasnoState.lastUpdatedOn;
let lastYasnoNotifiedUpdatedOn = yasnoState.lastNotifiedUpdatedOn;
let lastYasnoNotifyAt = yasnoState.lastNotifyAt;
let yasnoCheckInProgress = false;
let cachedYasnoGroup = null;
let botUsername = null;

function defaultAccess() {
    return {
        users: [],
        invites: {}
    };
}

function ensureUserRecord(parsed, id, role, name = role) {
    const existing = parsed.users.find((u) => Number(u.id) === Number(id));
    if (existing) {
        existing.role = role;
        return existing;
    }
    const row = {
        id: Number(id),
        name,
        username: null,
        role,
        joinedAt: new Date().toISOString()
    };
    parsed.users.push(row);
    return row;
}

function loadAccess() {
    try {
        const parsed = fs.existsSync(ACCESS_FILE)
            ? JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'))
            : defaultAccess();
        if (!parsed.users || !Array.isArray(parsed.users)) parsed.users = [];
        if (!parsed.invites || typeof parsed.invites !== 'object') parsed.invites = {};

        // Адміни + MEMBER_IDS з env завжди в списку (переживають редеплой)
        for (const adminId of ADMIN_IDS) {
            ensureUserRecord(parsed, adminId, 'admin', 'admin');
        }
        for (const memberId of MEMBER_IDS) {
            if (!ADMIN_IDS.includes(memberId)) {
                ensureUserRecord(parsed, memberId, 'member', 'member');
            }
        }
        return parsed;
    } catch (error) {
        console.error('Не вдалося прочитати access.json:', error);
        const fallback = defaultAccess();
        for (const adminId of ADMIN_IDS) ensureUserRecord(fallback, adminId, 'admin', 'admin');
        for (const memberId of MEMBER_IDS) {
            if (!ADMIN_IDS.includes(memberId)) ensureUserRecord(fallback, memberId, 'member', 'member');
        }
        return fallback;
    }
}

function saveAccess(data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Не вдалося зберегти access.json:', error.message || error);
        return false;
    }
}

let access = loadAccess();
saveAccess(access);

bot.catch((err, ctx) => {
    console.error('Telegraf error:', err);
    if (ctx && ctx.reply) {
        ctx.reply('⚠️ Сталася помилка. Спробуй ще раз через кілька секунд.').catch(() => {});
    }
});

function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
}

function isAllowed(userId) {
    const id = Number(userId);
    return (
        isAdmin(id) ||
        MEMBER_IDS.includes(id) ||
        access.users.some((u) => Number(u.id) === id)
    );
}

function allowedUserIds() {
    const ids = new Set([...ADMIN_IDS, ...MEMBER_IDS]);
    for (const user of access.users) ids.add(Number(user.id));
    return [...ids];
}

function recommendedMemberIdsEnv() {
    const ids = allowedUserIds().filter((id) => !isAdmin(id));
    return ids.join(',');
}

function mainKeyboard(userId) {
    const rows = [
        ['💡 Перевірити світло вдома'],
        ['📅 Графік YASNO']
    ];
    if (isAdmin(userId)) {
        rows.push(['🎟️ Інвайт']);
    }
    return Markup.keyboard(rows).resize();
}

function denyAccess(ctx) {
    return ctx.reply('⛔ Бот лише за запрошенням. Попроси в адміна інвайт.');
}

function addMember(from) {
    const id = Number(from.id);
    const existing = access.users.find((u) => Number(u.id) === id);
    const profile = {
        id,
        name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(id),
        username: from.username || null,
        role: isAdmin(id) ? 'admin' : 'member',
        joinedAt: existing?.joinedAt || new Date().toISOString()
    };

    if (existing) Object.assign(existing, profile);
    else access.users.push(profile);

    saveAccess(access);
    return profile;
}

function createInvite(createdBy) {
    const code = crypto.randomBytes(4).toString('hex');
    access.invites[code] = {
        createdBy: Number(createdBy),
        createdAt: new Date().toISOString(),
        usedBy: null
    };
    saveAccess(access);
    return code;
}

function redeemInvite(code, from) {
    const invite = access.invites[String(code || '').trim()];
    if (!invite) return { ok: false, reason: 'Інвайт недійсний або вже використаний.' };
    if (invite.usedBy) return { ok: false, reason: 'Цей інвайт уже використано.' };

    invite.usedBy = Number(from.id);
    invite.usedAt = new Date().toISOString();
    addMember(from);
    return { ok: true };
}

async function notifyAdminsNewMember(from) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || from.id;
    const memberEnv = recommendedMemberIdsEnv();
    const text =
        `👤 Новий юзер за інвайтом: ${name} (\`${from.id}\`)\n\n` +
        `Щоб після деплою не треба було інвайтити знову — постав у Render:\n` +
        `\`MEMBER_IDS=${memberEnv}\``;

    for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' }).catch(() => {});
    }
}

async function sendInviteLink(ctx) {
    try {
        if (!botUsername) {
            const me = await bot.telegram.getMe();
            botUsername = me.username;
        }
        if (!botUsername) {
            return ctx.reply('⚠️ Не вдалося отримати username бота. Перевір, що в @BotFather задано username.');
        }

        const code = createInvite(ctx.from.id);
        const link = `https://t.me/${botUsername}?start=${code}`;
        // Без Markdown: інакше _ у username бота ламає повідомлення
        return ctx.reply(
            `🎟️ Одноразове запрошення:\n${code}\n\n${link}\n\n` +
            `Після входу оновлю MEMBER_IDS у Render — і доступ не злетить після деплою.`
        );
    } catch (error) {
        console.error('Помилка створення інвайту:', error);
        return ctx.reply(`⚠️ Не вдалося створити інвайт: ${error.message || error}`);
    }
}

const YASNO_HEADERS = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// Перевірка статусу розетки Smart Life / Tuya API
// Повертає { online: boolean|null, error: string|null }
async function getSmartLifeStatus() {
    try {
        if (!TUYA_CLIENT_ID || !TUYA_SECRET) {
            return { online: null, error: 'Не задані TUYA_CLIENT_ID / TUYA_SECRET' };
        }

        const t = Date.now().toString();
        const clientId = TUYA_CLIENT_ID;
        const secret = TUYA_SECRET;

        // Крок 1: Отримуємо Access Token
        const signUrl = `/v1.0/token?grant_type=1`;
        const stringToSign = `GET\n${crypto.createHash('sha256').update('').digest('hex')}\n\n${signUrl}`;
        const signStr = clientId + t + stringToSign;
        const sign = crypto.createHmac('sha256', secret).update(signStr).digest('hex').toUpperCase();

        const tokenResponse = await fetch(`https://openapi.tuya${REGION}.com${signUrl}`, {
            method: 'GET',
            headers: {
                'client_id': clientId,
                't': t,
                'sign': sign,
                'sign_method': 'HMAC-SHA256'
            }
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.success || !tokenData.result) {
            console.error('Помилка отримання Tuya Token:', tokenData);
            return { online: null, error: tokenData.msg || 'Не вдалося отримати Tuya token' };
        }

        const accessToken = tokenData.result.access_token;

        // Крок 2: Запитуємо статус пристрою за допомогою отриманого токена
        const deviceUrl = `/v1.0/iot-03/devices/${DEVICE_ID}`;
        const t2 = Date.now().toString();
        const stringToSignDevice = `GET\n${crypto.createHash('sha256').update('').digest('hex')}\n\n${deviceUrl}`;
        const signStrDevice = clientId + accessToken + t2 + stringToSignDevice;
        const signDevice = crypto.createHmac('sha256', secret).update(signStrDevice).digest('hex').toUpperCase();

        const deviceResponse = await fetch(`https://openapi.tuya${REGION}.com${deviceUrl}`, {
            method: 'GET',
            headers: {
                'client_id': clientId,
                'access_token': accessToken,
                't': t2,
                'sign': signDevice,
                'sign_method': 'HMAC-SHA256'
            }
        });

        const deviceData = await deviceResponse.json();
        if (deviceData.success && deviceData.result) {
            return { online: Boolean(deviceData.result.online), error: null };
        }

        console.error('Помилка статусу пристрою Tuya:', deviceData);
        const apiMsg = deviceData.msg || 'Невідома помилка Tuya API';
        // Типова причина: у проєкті Tuya не підписано IoT Core
        if (String(apiMsg).toLowerCase().includes('iot core')) {
            return {
                online: null,
                error: 'У Tuya Cloud не підписано IoT Core. Відкрий Cloud → Project → Service API → Subscribe «IoT Core».'
            };
        }
        return { online: null, error: apiMsg };
    } catch (error) {
        console.error('Помилка запиту до Smart Life (Tuya):', error);
        return { online: null, error: error.message || 'Помилка зʼєднання з Tuya' };
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

function mergeOutageSlots(slots) {
    const outages = (Array.isArray(slots) ? slots : []).filter((s) => {
        const type = String(s.type || '').toLowerCase();
        return type.includes('definite') || type.includes('outage');
    });

    const sorted = outages
        .map((s) => ({
            start: Math.max(0, Math.min(1440, Number(s.start) || 0)),
            end: Math.max(0, Math.min(1440, Number(s.end) || 0))
        }))
        .filter((s) => s.end > s.start)
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
    return merged;
}

function lightSlotsFromOutages(outages) {
    const light = [];
    let cursor = 0;
    for (const outage of outages) {
        if (outage.start > cursor) {
            light.push({ start: cursor, end: outage.start });
        }
        cursor = Math.max(cursor, outage.end);
    }
    if (cursor < 1440) {
        light.push({ start: cursor, end: 1440 });
    }
    return light;
}

function formatSlots(slots) {
    if (!Array.isArray(slots) || slots.length === 0) {
        return 'Немає опублікованих слотів.';
    }

    const outages = mergeOutageSlots(slots);

    if (outages.length === 0) {
        return '🟢 Світло весь день (00:00 – 24:00)';
    }

    const light = lightSlotsFromOutages(outages);
    const parts = [];

    if (light.length > 0) {
        parts.push('*Світло є:*');
        parts.push(...light.map((s) => `🟢 ${minutesToTime(s.start)} – ${minutesToTime(s.end)}`));
    }

    parts.push('*Відключення:*');
    parts.push(...outages.map((s) => `🔴 ${minutesToTime(s.start)} – ${minutesToTime(s.end)}`));

    return parts.join('\n');
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

function yasnoDayFingerprint(day) {
    if (!day) return null;
    const slots = Array.isArray(day.slots)
        ? day.slots
            .map((s) => ({
                start: Number(s.start),
                end: Number(s.end),
                type: String(s.type || '')
            }))
            .sort((a, b) => a.start - b.start || a.end - b.end || a.type.localeCompare(b.type))
        : [];

    return {
        date: day.date || null,
        status: day.status || null,
        slots
    };
}

function yasnoContentHash(groupData) {
    const payload = {
        today: yasnoDayFingerprint(groupData.today),
        tomorrow: yasnoDayFingerprint(groupData.tomorrow)
    };
    return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
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
                hash: null,
                updatedOn: null
            };
        }

        // Хеш слотів — запасний сигнал; головний тригер сповіщень — updatedOn від YASNO
        const currentHash = yasnoContentHash(groupData);
        const updatedOn = groupData.updatedOn || null;

        let text =
            `📅 *Графік відключень YASNO*\n` +
            `📍 *Адреса:* ${YASNO_ADDRESS_LABEL}\n` +
            `🔢 *Група:* ${group}\n\n` +
            `${formatDayBlock('Сьогодні', groupData.today)}\n\n` +
            `${formatDayBlock('Завтра', groupData.tomorrow)}`;

        if (updatedOn) {
            text += `\n\n🕒 Оновлено: ${formatUpdatedOn(updatedOn)}`;
        }

        return { text: text.slice(0, 4000), hash: currentHash, group, updatedOn };
    } catch (error) {
        console.error('Помилка отримання графіка YASNO:', error);
        cachedYasnoGroup = null;
        return { text: '❌ Помилка з\'єднання з сервером графіків YASNO.', hash: null, updatedOn: null };
    }
}

// Фонова перевірка лише графіка YASNO (без Tuya — економимо квоту API)
// Головне: зміна updatedOn у YASNO → пуш одразу.
// Cooldown 30 хв — лише антидубль того самого updatedOn (напр. два інстанси Render).
setInterval(async () => {
    if (yasnoCheckInProgress) return;
    yasnoCheckInProgress = true;
    try {
        mergeYasnoStateFromDisk();

        const result = await getYasnoSchedule();
        if (!result.hash) return;

        // Перший запуск / після втрати стану — лише baseline, без пушу
        if (lastYasnoHash === null && lastYasnoUpdatedOn === null) {
            lastYasnoHash = result.hash;
            lastYasnoUpdatedOn = result.updatedOn;
            persistYasnoState();
            return;
        }

        const updatedOn = result.updatedOn || null;
        const yasnoPublishedNewUpdate = Boolean(updatedOn) && updatedOn !== lastYasnoNotifiedUpdatedOn;
        const sameUpdatedOnSeen = Boolean(updatedOn) && updatedOn === lastYasnoUpdatedOn;
        const sameHash = result.hash === lastYasnoHash;
        const hashOnlyChange = !updatedOn && result.hash !== lastYasnoNotifiedHash;

        // Нічого нового відносно останнього сповіщення
        if (!yasnoPublishedNewUpdate && !hashOnlyChange && sameHash && (sameUpdatedOnSeen || !updatedOn)) {
            return;
        }

        if (updatedOn) {
            lastYasnoUpdatedOn = updatedOn;
        }
        lastYasnoHash = result.hash;

        // Той самий "Останнє оновлення" з YASNO вже слали — антидубль
        if (updatedOn && updatedOn === lastYasnoNotifiedUpdatedOn) {
            persistYasnoState();
            return;
        }

        if (!yasnoPublishedNewUpdate && !hashOnlyChange) {
            persistYasnoState();
            return;
        }

        // Новий updatedOn від YASNO → пуш одразу (без очікування 30 хв).
        // Cooldown 30 хв — лише для fallback по хешу без updatedOn.
        if (!yasnoPublishedNewUpdate && isYasnoNotifyCooldownActive()) {
            persistYasnoState();
            console.log('YASNO: пропуск дубля через cooldown (немає нового updatedOn)');
            return;
        }

        const now = Date.now();
        lastYasnoNotifiedHash = result.hash;
        lastYasnoNotifiedUpdatedOn = updatedOn || lastYasnoNotifiedUpdatedOn;
        lastYasnoNotifyAt = now;
        persistYasnoState();

        console.log(`YASNO: сповіщення (updatedOn=${updatedOn || 'n/a'})`);

        const notificationText = `🔔 *Увага! Оновлено графік відключень для Ахматової, 13Д!*\n\n${result.text}`;
        const recipients = [...new Set(allowedUserIds())];

        for (const userId of recipients) {
            await bot.telegram.sendMessage(userId, notificationText, { parse_mode: 'Markdown' }).catch((err) => {
                console.error(`Не вдалося надіслати сповіщення користувачу ${userId}:`, err);
            });
        }
    } catch (e) {
        console.error('Помилка у фоновій перевірці YASNO:', e);
    } finally {
        yasnoCheckInProgress = false;
    }
}, 2 * 60 * 1000);

async function replyLightStatus(ctx) {
    const loadingMsg = await ctx.reply('⏳ Перевіряю стан розетки...');
    const power = await getSmartLifeStatus();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (power.error || power.online === null) {
        return ctx.reply(`⚠️ Не вдалося перевірити розетку:\n${power.error || 'невідома помилка'}`);
    }

    if (power.online) {
        return ctx.reply('🟢 Світло є!');
    }
    return ctx.reply('🔴 Світла немає!');
}

async function replyYasnoSchedule(ctx) {
    const loadingMsg = await ctx.reply('⏳ Завантажую графік для Ахматової, 13Д...');
    const result = await getYasnoSchedule();

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (result.hash) {
        lastYasnoHash = result.hash;
    }

    const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.url('🌐 Офіційна сторінка YASNO', 'https://static.yasno.ua/kyiv/outages')]
    ]);

    return ctx.reply(result.text, {
        parse_mode: 'Markdown',
        ...inlineKeyboard
    });
}

bot.start(async (ctx) => {
    const payload = (ctx.startPayload || '').trim();

    if (payload) {
        if (isAllowed(ctx.from.id)) {
            addMember(ctx.from);
            return ctx.reply('✅ У вас уже є доступ.', mainKeyboard(ctx.from.id));
        }

        const result = redeemInvite(payload, ctx.from);
        if (!result.ok) {
            return ctx.reply(`⛔ ${result.reason}`);
        }

        await notifyAdminsNewMember(ctx.from);
        return ctx.reply('✅ Запрошення прийнято! Оберіть дію:', mainKeyboard(ctx.from.id));
    }

    if (!isAllowed(ctx.from.id)) {
        return denyAccess(ctx);
    }

    addMember(ctx.from);

    const hint = isAdmin(ctx.from.id)
        ? '\n\nКнопка «🎟️ Інвайт» — створити посилання\n/users — список\n/kick <id> — забрати доступ'
        : '';

    return ctx.reply(`Привіт! Оберіть дію на клавіатурі нижче:${hint}`, mainKeyboard(ctx.from.id));
});

bot.command('invite', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.reply('⛔ Лише адмін.');
    }
    return sendInviteLink(ctx);
});

bot.hears('🎟️ Інвайт', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return denyAccess(ctx);
    }
    return sendInviteLink(ctx);
});

bot.command('ping', async (ctx) => {
    return ctx.reply('pong');
});

bot.command('users', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.reply('⛔ Лише адмін.');
    }

    access = loadAccess();
    const ids = allowedUserIds();
    const lines = ids.map((id, i) => {
        const fromFile = access.users.find((u) => Number(u.id) === id);
        const uname = fromFile
            ? (fromFile.username ? `@${fromFile.username}` : fromFile.name || '—')
            : '—';
        const role = isAdmin(id) ? 'admin' : MEMBER_IDS.includes(id) ? 'member(env)' : (fromFile?.role || 'member');
        return `${i + 1}. ${uname} — \`${id}\` (${role})`;
    });

    const memberEnv = recommendedMemberIdsEnv();
    return ctx.reply(
        `👥 Користувачі:\n${lines.join('\n')}\n\n` +
        `MEMBER_IDS для Render:\n\`MEMBER_IDS=${memberEnv || '(поки порожньо)'}\``,
        { parse_mode: 'Markdown' }
    );
});

bot.command('kick', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.reply('⛔ Лише адмін.');
    }

    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const targetId = Number(parts[1]);
    if (!targetId) {
        return ctx.reply('Використання: /kick <telegram_id>');
    }
    if (isAdmin(targetId)) {
        return ctx.reply('⛔ Не можна видалити адміна.');
    }

    access = loadAccess();
    const before = access.users.length;
    access.users = access.users.filter((u) => Number(u.id) !== targetId);
    saveAccess(access);

    const stillInEnv = MEMBER_IDS.includes(targetId);
    if (access.users.length === before && !stillInEnv) {
        return ctx.reply('Користувача не знайдено.');
    }

    let text = `🗑️ Доступ для \`${targetId}\` прибрано з файлу.`;
    if (stillInEnv) {
        text += `\n⚠️ Він ще в \`MEMBER_IDS\` — прибери ID з env на Render.`;
    }

    return ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.hears('💡 Перевірити світло вдома', async (ctx) => {
    if (!isAllowed(ctx.from.id)) {
        return denyAccess(ctx);
    }
    return replyLightStatus(ctx);
});

bot.hears('📅 Графік YASNO', async (ctx) => {
    if (!isAllowed(ctx.from.id)) {
        return denyAccess(ctx);
    }
    return replyYasnoSchedule(ctx);
});

bot.on(['sticker', 'voice', 'video_note'], async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply('⛔ Стікери, голосові та кружки в цьому боті вимкнені.');
});

const PORT = process.env.PORT || 3000;
const webhookPath = `/bot${TOKEN}`;

// Не вішати express.json() перед webhook — ламає updates від Telegram
app.use(bot.webhookCallback(webhookPath));

app.get('/', (req, res) => {
    res.send('Smart Life / Atorch Telegram Bot is running!');
});

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);

    // Спочатку швидко піднімаємо HTTP, важке — після listen,
    // щоб перший запит після сну Render встиг обробитись.
    try {
        const me = await bot.telegram.getMe();
        botUsername = me.username;
        console.log(`Bot @${botUsername}`);
    } catch (error) {
        console.error('Не вдалося отримати username бота:', error);
    }

    if (WEBHOOK_URL) {
        try {
            const wantUrl = `${WEBHOOK_URL}${webhookPath}`;
            const info = await bot.telegram.getWebhookInfo();

            // Не викликаємо drop_pending_updates при кожному прокиданні —
            // інакше Telegram втрачає перше повідомлення, яке розбудило сервер.
            if (!info.url || info.url !== wantUrl) {
                await bot.telegram.setWebhook(wantUrl);
                console.log(`Webhook set to ${wantUrl}`);
            } else {
                console.log(`Webhook already set: ${info.url}`);
            }
        } catch (error) {
            console.error('Не вдалося перевірити/встановити webhook:', error);
        }
    } else {
        console.warn('RENDER_EXTERNAL_URL не задано — webhook не встановлено');
    }
});