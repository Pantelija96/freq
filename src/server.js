require('dotenv').config();

const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const PDFDocument = require("pdfkit");

const config = require('./config/index');
const pool = require('./config/db');
const mainRouter = require('./routes/index');
const logger = require('./utils/logger');

const app = express();

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', mainRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', env: config.env });
});

const server = https.createServer({
    key: fs.readFileSync(config.https.key),
    cert: fs.readFileSync(config.https.cert)
}, app);

const wss = new WebSocketServer({ server });

const dashboardClients = new Set();
const activeDevices = new Map();

app.locals.activeDevices = activeDevices;

const PING_INTERVAL = 30000;
const MAX_MISSED_PONGS = 3;

console.log(`Server starting on https://0.0.0.0:${config.port}`);
console.log(`Environment: ${config.env}`);

// HELPER FUNCTION

async function sendCommand(deviceId, command, payload = null) {

    const active = activeDevices.get(deviceId);
    const [result] = await pool.execute(
        `INSERT INTO commands 
        (device_id, session_id, command, payload, status)
        VALUES (?, ?, ?, ?, 'pending')`,
        [
            deviceId,
            active?.sessionId ?? null,
            command,
            JSON.stringify(payload || null)
        ]
    );

    const commandId = result.insertId;
    broadcastToDashboard({
        type: 'command_created',
        deviceId,
        commandId,
        command
    });

    if (active) {
        active.ws.send(JSON.stringify({
            type: 'command',
            command_id: commandId,
            command: command,
            payload: payload
        }));
        await pool.execute(
            `UPDATE commands SET status='sent' WHERE id=?`,
            [commandId]
        );
        logger.info('command_sent', {
            deviceId,
            commandId,
            command
        });

    } else {
        logger.info('command_queued_offline', {
            deviceId,
            commandId,
            command
        });

    }

    return commandId;
}

function compressToSegments(startTs, intervalMs, freqArray) {
    const segments = [];
    if (!Array.isArray(freqArray) || freqArray.length === 0) {
        return segments;
    }

    let i = 0;
    const n = freqArray.length;
    while (i < n) {
        const freq = Number(freqArray[i]) || 0;
        let j = i + 1;
        while (j < n && Number(freqArray[j]) === freq) {
            j++;
        }
        const segStart = startTs + BigInt(i * intervalMs);
        const segEnd   = startTs + BigInt(j * intervalMs);
        segments.push({
            start: segStart,
            end: segEnd,
            freq: freq
        });
        i = j;
    }

    return segments;
}

async function processFrequencyBatch(deviceId, payload) {
    console.log(payload);

    const batchId = payload.batch_id;
    if (!batchId) {
        logger.warn('missing_batch_id', { deviceId });
        return;
    }

    try {
        const [existing] = await pool.execute(
            `SELECT 1
             FROM processed_frequency_batches
             WHERE device_id=? AND batch_id=?`,
            [deviceId, batchId]
        );
        if (existing.length > 0) {
            logger.info('duplicate_frequency_batch_skipped', {
                deviceId,
                batchId
            });
            return;
        }

        await pool.execute(
            `INSERT INTO processed_frequency_batches
             (batch_id, device_id, status)
             VALUES (?, ?, 'received')`,
            [batchId, deviceId]
        );


        const startTs = BigInt(payload.start_timestamp || 0);
        const endTs   = BigInt(payload.end_timestamp || 0);
        const intervalMs = Number(payload.interval || 250);

        if (startTs <= 0 || endTs <= startTs) {
            throw new Error('invalid timestamps');
        }

        const durationMs = Number(endTs - startTs);

        // const MIN_BATCH_DURATION = 0;
        // const MAX_BATCH_DURATION = 2 * 60 * 60 * 1000;
        //
        // if (durationMs < MIN_BATCH_DURATION || durationMs > MAX_BATCH_DURATION) {
        //     throw new Error(`invalid batch duration ${durationMs}`);
        // }

        const expectedSamples = Math.round(durationMs / intervalMs) + 1;

        // const MAX_SAMPLES = 20000;
        // if (expectedSamples > MAX_SAMPLES) {
        //     throw new Error(`too many samples ${expectedSamples}`);
        // }


        function normalizeFreqArray(freqArray, expected) {
            if (!Array.isArray(freqArray) || freqArray.length === 0) {
                logger.warn('empty_frequency_array', { deviceId, batchId });
                return new Array(expected).fill(0);
            }

            if (freqArray.length === 1) {

                const freq = Number(freqArray[0]) || 0;
                logger.info('constant_frequency_batch', {
                    deviceId,
                    batchId,
                    freq
                });
                return new Array(expected).fill(freq);
            }

            const normalized = freqArray.map(f => {
                const num = Number(f);
                return isNaN(num) ? 0 : Math.round(num);
            });

            if (normalized.length > expected) {
                logger.warn('frequency_array_trimmed', {
                    deviceId,
                    batchId,
                    expected,
                    received: normalized.length
                });
                return normalized.slice(0, expected);
            }

            if (normalized.length < expected) {
                const lastFreq = normalized[normalized.length - 1] || 0;
                logger.warn('frequency_array_extended', {
                    deviceId,
                    batchId,
                    expected,
                    received: normalized.length
                });
                while (normalized.length < expected) {
                    normalized.push(lastFreq);
                }
            }

            return normalized;
        }

        const smallFreq = normalizeFreqArray(
            payload.small_cores_frequency || [],
            expectedSamples
        );

        const bigFreq = normalizeFreqArray(
            payload.big_cores_frequency || [],
            expectedSamples
        );


        const smallSegments = compressToSegments(startTs, intervalMs, smallFreq);
        const bigSegments   = compressToSegments(startTs, intervalMs, bigFreq);
        const allRows = [
            ...smallSegments.map(s => [deviceId, 'small', s.start, s.end, s.freq, batchId]),
            ...bigSegments.map(s => [deviceId, 'big', s.start, s.end, s.freq, batchId])
        ];
        if (allRows.length === 0) {
            await markBatchProcessed(batchId, 0);
            logger.warn('empty_frequency_segments', {
                deviceId,
                batchId
            });
            return;
        }


        await pool.query(
            `INSERT IGNORE INTO cpu_frequency_segments
             (device_id, core_type, segment_start, segment_end, frequency_khz, batch_id)
             VALUES ?`,
            [allRows]
        );
        await markBatchProcessed(deviceId, batchId, allRows.length);
        logger.info('frequency_batch_processed', {
            deviceId,
            batchId,
            durationSeconds: durationMs / 1000,
            expectedSamples,
            smallSegments: smallSegments.length,
            bigSegments: bigSegments.length,
            totalSegments: allRows.length
        });
    } catch (err) {
        logger.error('processFrequencyBatch_failed', {
            deviceId,
            batchId,
            error: err.message
        });
        await markBatchFailed(batchId, err.message.substring(0,255))
            .catch(() => {});
    }
}

async function processStatsPayload(deviceId, payload) {

    const { boot_time, apps = [], crashes = [], fixed = null } = payload;

    if (!boot_time) {
        logger.warn('stats_missing_boot_time', { deviceId });
        return;
    }

    try {
        const [statResult] = await pool.execute(
            `INSERT INTO device_stats (device_id, boot_time, fixed)
             VALUES (?, ?, ?)`,
            [deviceId, boot_time, fixed]
        );

        const deviceStatId = statResult.insertId;
        const packages = new Set();
        for (const app of apps) {
            if (app.package) packages.add(app.package);
        }
        for (const crash of crashes) {
            if (crash.package) packages.add(crash.package);
        }


        const packageList = Array.from(packages);
        let appMap = new Map();
        if (packageList.length > 0) {
            const placeholders = packageList.map(() => '?').join(',');
            const [rows] = await pool.execute(
                `SELECT id, package_name
                 FROM applications
                 WHERE package_name IN (${placeholders})`,
                packageList
            );
            for (const row of rows) {
                appMap.set(row.package_name, row.id);
            }
        }



        for (const pkg of packageList) {
            if (!appMap.has(pkg)) {
                const [insertRes] = await pool.execute(
                    `INSERT INTO applications (package_name, app_name)
                     VALUES (?, ?)`,
                    [pkg, pkg]
                );
                appMap.set(pkg, insertRes.insertId);
                logger.info('new_application_from_stats', {
                    package: pkg,
                    applicationId: insertRes.insertId
                });
            }
        }


        const appStatsRows = [];
        for (const app of apps) {
            const applicationId = appMap.get(app.package);
            if (!applicationId) continue;
            appStatsRows.push([
                deviceStatId,
                applicationId,
                Number(app.cpu_time || 0),
                Number(app.battery_pct || 0),
                Number(app.received_mb || 0),
                Number(app.transmitted_mb || 0)
            ]);
        }

        if (appStatsRows.length > 0) {
            await pool.query(
                `INSERT INTO device_app_stats
                 (device_stat_id, application_id, cpu_time_sec, battery_pct, received_mb, transmitted_mb)
                 VALUES ?`,
                [appStatsRows]
            );
        }

        const crashRows = [];
        for (const crash of crashes) {
            if (!crash.time || !crash.package) continue;
            const applicationId = appMap.get(crash.package);
            if (!applicationId) continue;
            const crashTime = parseAndroidCrashTime(crash.time);

            crashRows.push([
                deviceStatId,
                applicationId,
                crashTime,
                crash.reason || null
            ]);
        }

        if (crashRows.length > 0) {
            await pool.query(
                `INSERT INTO device_app_crashes
                 (device_stat_id, application_id, crash_time, reason)
                 VALUES ?`,
                [crashRows]
            );
        }

        logger.info('stats_processed_successfully', {
            deviceId,
            boot_time,
            appsCount: apps.length,
            crashesCount: crashes.length,
            deviceStatId
        });
    } catch (err) {

        logger.error('processStatsPayload_failed', {
            deviceId,
            error: err.message,
            stack: err.stack?.substring(0, 300)
        });
    }
}

async function broadcastDeviceStats(deviceId){

    const [stats] = await pool.execute(`
        SELECT id, boot_time, collected_at
        FROM device_stats
        WHERE device_id = ?
        ORDER BY collected_at DESC
        LIMIT 1
    `,[deviceId]);

    if(!stats.length) return;

    const statId = stats[0].id;

    const [apps] = await pool.execute(`
        SELECT 
            a.package_name,
            a.app_name,
            das.cpu_time_sec,
            das.battery_pct,
            das.received_mb,
            das.transmitted_mb
        FROM device_app_stats das
        JOIN applications a ON a.id = das.application_id
        WHERE das.device_stat_id = ?
        ORDER BY das.cpu_time_sec DESC
    `,[statId]);

    const [crashes] = await pool.execute(`
        SELECT 
            a.package_name,
            a.app_name,
            dac.crash_time,
            dac.reason
        FROM device_app_crashes dac
        JOIN applications a ON a.id = dac.application_id
        WHERE dac.device_stat_id = ?
        ORDER BY dac.crash_time DESC
    `,[statId]);

    broadcastToDashboard({
        type: "device_stats",
        deviceId: deviceId,
        apps: apps,
        crashes: crashes,
        collected_at: stats[0].collected_at
    });

}

function broadcastToDashboard(data) {
    const msg = JSON.stringify(data);
    for (const client of dashboardClients) {
        if (client.readyState === 1) {
            client.send(msg);
        }
    }
}

async function markBatchProcessed(deviceId, batchId, segmentsCount) {

    await pool.execute(
        `UPDATE processed_frequency_batches
         SET status='processed',
             processed_at=CURRENT_TIMESTAMP(3),
             segments_count=?
         WHERE device_id=? AND batch_id=?`,
        [segmentsCount, deviceId, batchId]
    );
}

async function markBatchFailed(deviceId, batchId, errorMessage) {

    await pool.execute(
        `UPDATE processed_frequency_batches
         SET status='failed', processed_at=CURRENT_TIMESTAMP(3), segments_count=? 
        WHERE device_id=? AND batch_id=?`,
        [errorMessage, deviceId, batchId]
    );
}

async function handleDeviceDisconnect(ws, reason = "connection_lost") {
    if (!ws.deviceId) return;
    const active = activeDevices.get(ws.deviceId);

    if (active && active.sessionId === ws.sessionId) {
        activeDevices.delete(ws.deviceId);
        await pool.execute(
            `UPDATE devices SET online=0 WHERE id=?`,
            [ws.deviceId]
        );
        broadcastToDashboard({
            type: 'device_offline',
            deviceId: ws.deviceId,
            sessionId: ws.sessionId,
            timestamp: new Date().toISOString(),
            reason
        });
        logger.info('device_disconnected', {
            deviceId: ws.deviceId,
            reason
        });
    }
}

function parseAndroidCrashTime(timeStr){
    const year = new Date().getFullYear();
    const [datePart,timePart] = timeStr.split(" ");
    const [month,day] = datePart.split("-");
    const cleanTime = timePart.split(".")[0]; // remove milliseconds
    return `${year}-${month}-${day} ${cleanTime}`;
}

// WEBSOCKET HANDLING

wss.on('connection', (ws, req) => {

    const isDashboard = req.url === '/dashboard';
    if (isDashboard) {
        dashboardClients.add(ws);

        ws.on('close', () => {
            dashboardClients.delete(ws);
        });

        ws.send(JSON.stringify({ type: 'hello_dashboard' }));
        return;
    }


    ws.missedPongs = 0;
    ws.on('pong', () => {
        ws.missedPongs = 0;
    });

    ws.on('message', async (message) => {
        try {
            let data;

            try {
                data = JSON.parse(message);
            } catch {
                logger.warn('invalid_ws_json');
                return;
            }

            // -------- AUTH --------
            if (data.type === 'auth') {

                logger.info('device_ws_auth_attempt', {
                    imei: data.imei,
                    ip: ws._socket?.remoteAddress
                });

                if (!data.imei || !data.device_token) {
                    logger.warn('device_ws_auth_invalid_payload', {
                        ip: ws._socket?.remoteAddress
                    });
                    ws.close();
                    return;
                }

                const fixed = data.fixed === true ? 1 : 0;

                try {
                    const [rows] = await pool.execute(
                        `SELECT id, device_name FROM devices WHERE imei = ? AND device_token = ? LIMIT 1`,
                        [data.imei, data.device_token]
                    );
                    if (!rows.length) {
                        logger.warn('device_ws_auth_failed', {
                            imei: data.imei,
                            ip: ws._socket?.remoteAddress,
                            reason: 'invalid_credentials'
                        });
                        ws.close();
                        return;
                    }

                    const deviceId = rows[0].id;

                    if (activeDevices.has(deviceId)) {
                        const oldSession = activeDevices.get(deviceId);

                        logger.warn('device_duplicate_session', {
                            deviceId,
                            oldSessionId: oldSession.sessionId
                        });

                        oldSession.ws.terminate();
                    }

                    const sessionId = crypto.randomUUID();

                    ws.deviceId = deviceId;
                    ws.sessionId = sessionId;

                    activeDevices.set(deviceId, {
                        ws,
                        sessionId
                    });

                    await pool.execute(
                        `UPDATE devices SET online = 1, last_seen = NOW(), fixer_enabled = ? WHERE id = ?`,
                        [fixed, deviceId]
                    );

                    ws.send(JSON.stringify({
                        type: 'auth_ok',
                        session_id: sessionId
                    }));

                    broadcastToDashboard({
                        type: 'device_online',
                        deviceId,
                        sessionId,
                        fixed: fixed === 1,
                        timestamp: new Date().toISOString()
                    });

                    logger.info('device_ws_auth_success', {
                        deviceId,
                        imei: data.imei,
                        sessionId,
                        fixed: fixed === 1,
                        ip: ws._socket?.remoteAddress
                    });

                    const [pendingCommands] = await pool.execute(
                        `SELECT id, command, payload FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY id ASC`,
                        [deviceId]
                    );

                    for (const cmd of pendingCommands) {
                        let payload = null;
                        try {
                            payload = cmd.payload ? JSON.parse(cmd.payload) : null;
                        } catch {}

                        ws.send(JSON.stringify({
                            type: 'command',
                            command_id: cmd.id,
                            command: cmd.command,
                            payload
                        }));
                        await pool.execute(
                            `UPDATE commands SET status='sent' WHERE id=?`,
                            [cmd.id]
                        );
                        logger.info('command_resent_on_reconnect', {
                            deviceId,
                            commandId: cmd.id,
                            command: cmd.command
                        });
                    }

                } catch (err) {
                    logger.error('device_ws_auth_error', {
                        imei: data.imei,
                        error: err.message,
                        stack: err.stack?.substring(0, 500)
                    });
                    ws.close();
                }
            }

            // -------- FREQUENCY BATCH --------
            if (data.type === 'frequency_batch') {

                if (!ws.deviceId) {
                    ws.send(JSON.stringify({
                        type: 'frequency_batch_ack',
                        batch_id: data.batch_id || 'unknown',
                        status: 'error',
                        error: 'not_authenticated'
                    }));
                    return;
                }

                if (!data.batch_id || !data.start_timestamp || !data.end_timestamp) {
                    ws.send(JSON.stringify({
                        type: 'frequency_batch_ack',
                        batch_id: data.batch_id || 'unknown',
                        status: 'error',
                        error: 'invalid_payload'
                    }));
                    return;
                }

                const batchId = data.batch_id;

                logger.info('frequency_batch_received', {
                    deviceId: ws.deviceId,
                    batchId,
                    smallSamples: data.small_cores_frequency?.length || 0,
                    bigSamples: data.big_cores_frequency?.length || 0
                });

                ws.send(JSON.stringify({
                    type: 'frequency_batch_ack',
                    batch_id: batchId,
                    status: 'accepted',
                    received_at: Date.now()
                }));

                processFrequencyBatch(ws.deviceId, data)
                    .then(() => {
                    broadcastToDashboard({
                        type: "frequency_batch",
                        deviceId: ws.deviceId,
                        start: data.start_timestamp,
                        end: data.end_timestamp,
                        small: data.small_cores_frequency,
                        big: data.big_cores_frequency,
                        interval: data.interval || 250
                    });
                })
                    .catch(err => {
                        logger.error('frequency_batch_processing_failed', {
                            deviceId: ws.deviceId,
                            batchId,
                            error: err.message
                        });
                    });
            }

            // -------- COMMAND STATUS FROM DEVICE --------
            if (data.type === 'command_status') {

                const { command_id, status, error } = data;

                await pool.execute(`
                    UPDATE commands
                    SET status=?, error_message=?, updated_at=NOW()
                    WHERE id=?
                `, [status, error || null, command_id]);

                const [rows] = await pool.execute(`
                    SELECT id, device_id, command, status, created_at
                    FROM commands WHERE id=?
                `, [command_id]);

                if (rows.length) {
                    broadcastToDashboard({
                        type: 'command_update',
                        command: rows[0]
                    });
                }
            }

            // -------- COMMAND ACK --------
            if (data.type === 'command_ack') {

                if (!data.command_id) return;

                await pool.execute(
                    `UPDATE commands
                     SET status='acknowledged', updated_at=NOW()
                     WHERE id=?`,
                    [data.command_id]
                );

                logger.info('command_ack', {
                    deviceId: ws.deviceId,
                    commandId: data.command_id
                });
            }

            // -------- COMMAND RESULT --------
            if (data.type === 'command_result') {

                const success = data.success === true;

                await pool.execute(
                    `UPDATE commands
                     SET status=?,
                         result=?,
                         error_message=?,
                         executed_at=NOW(),
                         updated_at=NOW()
                     WHERE id=?`,
                    [
                        success ? 'done' : 'failed',
                        JSON.stringify(data.result || null),
                        data.error || null,
                        data.command_id
                    ]
                );

                broadcastToDashboard({
                    type: 'command_result',
                    deviceId: ws.deviceId,
                    commandId: data.command_id,
                    success
                });

                logger.info('command_result', {
                    deviceId: ws.deviceId,
                    commandId: data.command_id,
                    success
                });
            }

            // -------- STATS --------
            if (data.type === 'stats') {
                if (!ws.deviceId) {
                    ws.send(JSON.stringify({
                        type: 'stats_ack',
                        status: 'error',
                        error: 'not_authenticated'
                    }));
                    return;
                }

                ws.send(JSON.stringify({
                    type: 'stats_ack',
                    status: 'accepted',
                    received_at: Date.now()
                }));

                processStatsPayload(ws.deviceId, data)
                    .then(()=> broadcastDeviceStats(ws.deviceId))
                    .catch(err => {
                        logger.error('stats_processing_failed', {
                            deviceId: ws.deviceId,
                            error: err.message
                        });
                    });
            }

            // -------- USER ACTION --------
            if (data.type === 'user_action') {

                if (!ws.deviceId) return;

                const action = data.action;

                if (!['enable_fixer','disable_fixer','logout'].includes(action)) {
                    logger.warn('invalid_user_action', {
                        deviceId: ws.deviceId,
                        action
                    });
                    return;
                }

                try {
                    await pool.execute(
                        `INSERT INTO device_user_actions (device_id, action)
                            VALUES (?, ?)`, [ws.deviceId, action]
                    );


                    if (action === 'enable_fixer' || action === 'disable_fixer') {
                        const enabled = action === 'enable_fixer' ? 1 : 0;
                        await pool.execute(
                            `UPDATE devices SET fixer_enabled = ? WHERE id = ?`,
                            [enabled, ws.deviceId]
                        );
                    }

                    if (action === 'logout') {
                        await pool.execute(
                            `UPDATE devices SET online = 0 WHERE id = ?`,
                            [ws.deviceId]
                        );

                        broadcastToDashboard({
                            type: 'device_logout',
                            deviceId: ws.deviceId,
                            sessionId: ws.sessionId,
                            timestamp: new Date().toISOString(),
                            reason: "logout"
                        });

                        logger.info('device_user_logout', {
                            deviceId: ws.deviceId,
                            sessionId: ws.sessionId
                        });

                        ws.terminate();
                        return;
                    }

                    broadcastToDashboard({
                        type: 'device_user_action',
                        deviceId: ws.deviceId,
                        action,
                        timestamp: new Date().toISOString()
                    });

                    logger.info('device_user_action', {
                        deviceId: ws.deviceId,
                        action
                    });

                } catch (err) {
                    logger.error('device_user_action_failed', {
                        deviceId: ws.deviceId,
                        action,
                        error: err.message
                    });

                }
            }

        } catch (err) {
            logger.error('ws_error', {
                error: err.message,
                stack: err.stack
            });
        }
    });

    ws.on('close', async () => {
        try {
            await handleDeviceDisconnect(ws, "socket_closed");
        } catch (err) {
            logger.error('disconnect_handler_failed', {
                error: err.message
            });
        }

    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.deviceId) return;
        if (ws.missedPongs >= MAX_MISSED_PONGS) {
            handleDeviceDisconnect(ws, "ping_timeout");
            return ws.terminate();
        }
        ws.missedPongs++;
        ws.ping();
    });
}, PING_INTERVAL);


server.listen(config.port, '0.0.0.0', () => {
    console.log(`Server running on https://109.72.48.188:${config.port}`);
    console.log(`Server running on https://127.0.0.1:${config.port}`);
});