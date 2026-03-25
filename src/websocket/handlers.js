const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { broadcastToDashboard } = require('./broadcaster');
const { processFrequencyBatch } = require('../services/frequencyService');
const { processStatsPayload, broadcastDeviceStats } = require('../services/statsService');
const { handleDeviceDisconnect } = require('./connectionManager');
const { authorizeDashboardRequest } = require('../middleware/auth');

const PING_INTERVAL = 30000;
const MAX_MISSED_PONGS = 3;

function setupWebSocketHandlers(wss, dashboardClients, activeDevices) {
    // Attach locals so handlers can use them
    wss.app = { locals: { activeDevices, dashboardClients } };
    const broadcastDashboardEvent = (data) => broadcastToDashboard(data, dashboardClients);
    const broadcastStatsToDashboard = (deviceId) => broadcastDeviceStats(
        deviceId,
        (payload) => broadcastDashboardEvent(payload)
    );

    wss.on('connection', (ws, req) => {
        const requestUrl = new URL(req.url || '/', 'https://localhost');
        const isDashboard = requestUrl.pathname === '/dashboard';

        ws.activeDevices = activeDevices;
        ws.dashboardClients = dashboardClients;

        if (isDashboard) {
            if (!authorizeDashboardRequest(req)) {
                ws.close(1008, 'Unauthorized');
                return;
            }

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

                        broadcastDashboardEvent({
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
                            broadcastDashboardEvent({
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
                        broadcastDashboardEvent({
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

                    broadcastDashboardEvent({
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

                    processStatsPayload(ws.deviceId, data, broadcastStatsToDashboard)
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

                            broadcastDashboardEvent({
                                type: 'device_logout',
                                deviceId: ws.deviceId,
                                sessionId: ws.sessionId,
                                timestamp: new Date().toISOString(),
                                reason: "logout"
                            });

                            const activeSession = activeDevices.get(ws.deviceId);
                            if (activeSession?.sessionId === ws.sessionId) {
                                activeDevices.delete(ws.deviceId);
                            }

                            logger.info('device_user_logout', {
                                deviceId: ws.deviceId,
                                sessionId: ws.sessionId
                            });

                            ws.skipDisconnectCleanup = true;
                            ws.terminate();
                            return;
                        }

                        broadcastDashboardEvent({
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
            if (ws.skipDisconnectCleanup) {
                return;
            }

            try {
                await handleDeviceDisconnect(ws, ws.disconnectReason || "socket_closed");
            } catch (err) {
                logger.error('disconnect_handler_failed', {
                    error: err.message
                });
            }

        });
    });

    // Ping interval
    setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.deviceId) return;
            if (ws.missedPongs >= MAX_MISSED_PONGS) {
                ws.disconnectReason = "ping_timeout";
                ws.terminate();
                return;
            }
            ws.missedPongs++;
            ws.ping();
        });
    }, PING_INTERVAL);
}

module.exports = { setupWebSocketHandlers };
