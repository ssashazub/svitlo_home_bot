const crypto = require('crypto');
const WebSocket = require('ws');

const REGION_URL = {
    cn: 'wss://mqe.tuyacn.com:8285/',
    us: 'wss://mqe.tuyaus.com:8285/',
    eu: 'wss://mqe.tuyaeu.com:8285/',
    in: 'wss://mqe.tuyain.com:8285/'
};

const PING_INTERVAL_MS = 30 * 1000;
const PONG_TIMEOUT_MS = 90 * 1000;

function md5Hex(value) {
    return crypto.createHash('md5').update(value).digest('hex');
}

function buildPassword(accessId, accessKey) {
    const key = md5Hex(accessKey);
    return md5Hex(`${accessId}${key}`).substr(8, 16);
}

function topicUrl(baseUrl, accessId, envName) {
    const envPath = envName === 'test' ? 'event-test' : 'event';
    const query = 'subscriptionType=Failover&ackTimeoutMillis=30000';
    return `${baseUrl}ws/v2/consumer/persistent/${accessId}/out/${envPath}/${accessId}-sub?${query}`;
}

function decryptEcb(cipherText, accessKey) {
    const key = Buffer.from(accessKey.substring(8, 24), 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipherText, 'base64')),
        decipher.final()
    ]);
    return JSON.parse(decrypted.toString('utf8'));
}

function decryptGcm(cipherText, accessKey) {
    const key = Buffer.from(accessKey.substring(8, 24), 'utf8');
    const raw = Buffer.from(cipherText, 'base64');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

function decryptPayloadData(cipherText, accessKey, modeHint) {
    const preferGcm = String(modeHint || '').toLowerCase().includes('gcm');
    const order = preferGcm ? ['gcm', 'ecb'] : ['gcm', 'ecb'];
    let lastError = null;

    for (const mode of order) {
        try {
            return mode === 'gcm'
                ? decryptGcm(cipherText, accessKey)
                : decryptEcb(cipherText, accessKey);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Не вдалося розшифрувати повідомлення Tuya');
}

function normalizeEvent(decrypted) {
    if (!decrypted || typeof decrypted !== 'object') return null;

    const bizCode = String(decrypted.bizCode || decrypted.bizcode || '').trim();
    const eventType = String(decrypted.eventType || '').trim().toLowerCase();
    const bizData = decrypted.bizData || decrypted.data || {};
    const devId = String(bizData.devId || bizData.deviceId || decrypted.devId || '').trim();

    if (bizCode === 'deviceOnline' || eventType === 'online' || bizCode === 'online') {
        return { kind: 'online', devId, raw: decrypted };
    }
    if (bizCode === 'deviceOffline' || eventType === 'offline' || bizCode === 'offline') {
        return { kind: 'offline', devId, raw: decrypted };
    }

    return null;
}

/**
 * @param {object} options
 * @param {string} options.accessId
 * @param {string} options.accessKey
 * @param {string} [options.region]
 * @param {string} [options.env] prod|test
 * @param {string} options.deviceId
 * @param {(event: {kind:'online'|'offline', devId:string, raw:any}) => void|Promise<void>} options.onDevicePower
 * @param {(level:string, ...args:any[]) => void} [options.logger]
 */
function startTuyaPulsar(options) {
    const accessId = options.accessId;
    const accessKey = options.accessKey;
    const region = String(options.region || 'eu').toLowerCase();
    const envName = String(options.env || 'prod').toLowerCase() === 'test' ? 'test' : 'prod';
    const deviceId = String(options.deviceId || '').trim();
    const logger = options.logger || ((level, ...args) => console.log(level, ...args));
    const onDevicePower = options.onDevicePower;

    if (!accessId || !accessKey || !deviceId) {
        logger('WARN', 'Tuya Pulsar: пропуск — немає accessId/accessKey/deviceId');
        return { stop() {} };
    }

    const baseUrl = REGION_URL[region] || REGION_URL.eu;
    const password = buildPassword(accessId, accessKey);
    const url = topicUrl(baseUrl, accessId, envName);

    let ws = null;
    let stopped = false;
    let retryDelayMs = 1000;
    let keepAliveTimer = null;
    let reconnectTimer = null;
    let connId = 0;
    let lastPongAt = 0;
    let lastKind = null;
    let lastNotifyAt = 0;
    const DEDUP_MS = 15 * 1000;

    function clearKeepAlive() {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }

    function clearReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    function disposeSocket(socket, reason) {
        if (!socket) return;
        try {
            socket.removeAllListeners();
        } catch (_) { /* ignore */ }
        try {
            // terminate() одразу рве TCP — важливо для зомбі-сокета
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.terminate();
            }
        } catch (_) { /* ignore */ }
        if (reason) {
            logger('INFO', `Tuya Pulsar: dispose (${reason})`);
        }
    }

    /**
     * Раніше був setTimeout → один ping і тиша.
     * На idle (немає подій світла) Tuya/мережа могли «вбити» WS без close,
     * а HTTP (UptimeRobot) лишався живим → Consumers:0 при «живому» боті.
     */
    function startKeepAlive(myId) {
        clearKeepAlive();
        lastPongAt = Date.now();
        keepAliveTimer = setInterval(() => {
            if (myId !== connId || stopped) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            const silentFor = Date.now() - lastPongAt;
            if (silentFor > PONG_TIMEOUT_MS) {
                logger('WARN', `Tuya Pulsar: немає pong ${Math.round(silentFor / 1000)}с — force reconnect`);
                disposeSocket(ws, 'pong-timeout');
                ws = null;
                scheduleReconnect();
                return;
            }

            try {
                ws.ping(accessId);
            } catch (error) {
                logger('ERROR', 'Tuya Pulsar ping failed:', error.message || error);
                disposeSocket(ws, 'ping-error');
                ws = null;
                scheduleReconnect();
            }
        }, PING_INTERVAL_MS);
    }

    function scheduleReconnect() {
        if (stopped) return;
        clearKeepAlive();
        clearReconnect();
        logger('INFO', `Tuya Pulsar: reconnect через ${retryDelayMs}мс`);
        reconnectTimer = setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 60 * 1000);
    }

    function ack(messageId) {
        if (!messageId || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({ messageId }));
        } catch (error) {
            logger('ERROR', 'Tuya Pulsar ack failed:', error.message || error);
        }
    }

    async function handleRawMessage(raw) {
        const parsed = JSON.parse(String(raw));
        const messageId = parsed.messageId;
        const payloadB64 = parsed.payload;
        if (!payloadB64) {
            ack(messageId);
            return;
        }

        const payloadJson = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        const modeHint = (parsed.properties && (parsed.properties.em || parsed.properties.encryptType))
            || payloadJson.encryptType
            || '';

        let decrypted;
        try {
            decrypted = decryptPayloadData(payloadJson.data, accessKey, modeHint);
        } catch (error) {
            // Без ack повідомлення лишиться в Accumulated — логимо явно
            logger('ERROR', 'Tuya Pulsar decrypt failed (без ack):', error.message || error);
            throw error;
        }

        const event = normalizeEvent(decrypted);
        ack(messageId);

        if (!event) {
            const bizCode = decrypted && (decrypted.bizCode || decrypted.bizcode || decrypted.eventType);
            if (bizCode) {
                logger('INFO', `Tuya Pulsar: ігнор bizCode=${bizCode}`);
            }
            return;
        }
        if (event.devId && event.devId !== deviceId) {
            logger('INFO', `Tuya Pulsar: інший пристрій ${event.devId}`);
            return;
        }

        const now = Date.now();
        if (event.kind === lastKind && now - lastNotifyAt < DEDUP_MS) {
            logger('INFO', `Tuya Pulsar: пропуск дубля ${event.kind}`);
            return;
        }

        lastKind = event.kind;
        lastNotifyAt = now;
        await onDevicePower(event);
    }

    function connect() {
        if (stopped) return;
        clearReconnect();
        clearKeepAlive();

        // Закриваємо попередній сокет, щоб не було 2 consumers у Failover
        if (ws) {
            disposeSocket(ws, 'before-reconnect');
            ws = null;
        }

        const myId = ++connId;
        logger('INFO', `Tuya Pulsar: підключення #${myId} (${region}/${envName})...`);

        const socket = new WebSocket(url, {
            headers: {
                username: accessId,
                password
            }
        });
        ws = socket;

        socket.on('open', () => {
            if (myId !== connId) return;
            retryDelayMs = 1000;
            lastPongAt = Date.now();
            logger('INFO', `Tuya Pulsar: зʼєднання відкрито (#${myId})`);
            startKeepAlive(myId);
        });

        socket.on('message', async (data) => {
            if (myId !== connId) return;
            lastPongAt = Date.now();
            try {
                await handleRawMessage(data);
            } catch (error) {
                logger('ERROR', 'Tuya Pulsar message error:', error.message || error);
            }
        });

        socket.on('ping', () => {
            if (myId !== connId) return;
            lastPongAt = Date.now();
            try {
                socket.pong(accessId);
            } catch (_) { /* ignore */ }
        });

        socket.on('pong', () => {
            if (myId !== connId) return;
            lastPongAt = Date.now();
        });

        socket.on('error', (error) => {
            if (myId !== connId) return;
            logger('ERROR', `Tuya Pulsar socket error (#${myId}):`, error.message || error);
        });

        socket.on('close', (code, reason) => {
            if (myId !== connId) return;
            clearKeepAlive();
            const why = reason && reason.toString ? reason.toString() : String(reason || '');
            logger('WARN', `Tuya Pulsar: закрито (#${myId}, code=${code})${why ? ` ${why}` : ''}`);
            if (ws === socket) ws = null;
            if (stopped) return;
            scheduleReconnect();
        });
    }

    connect();

    return {
        stop() {
            stopped = true;
            clearReconnect();
            clearKeepAlive();
            disposeSocket(ws, 'stop');
            ws = null;
        }
    };
}

module.exports = {
    startTuyaPulsar
};
