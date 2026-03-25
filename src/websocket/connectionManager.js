const pool = require('../config/db');
const logger = require('../utils/logger');
const { broadcastToDashboard } = require('./broadcaster');

async function handleDeviceDisconnect(ws, reason = "connection_lost") {
    if (!ws?.deviceId) return;

    const activeDevices = ws.activeDevices;
    const dashboardClients = ws.dashboardClients;
    if (!activeDevices) return;

    const active = activeDevices.get(ws.deviceId);
    if (!active || active.sessionId !== ws.sessionId) return;

    activeDevices.delete(ws.deviceId);

    await pool.execute(`UPDATE devices SET online = 0 WHERE id = ?`, [ws.deviceId])
        .catch(err => logger.error('offline_update_failed', { deviceId: ws.deviceId, error: err.message }));

    broadcastToDashboard({
        type: 'device_offline',
        deviceId: ws.deviceId,
        sessionId: ws.sessionId,
        timestamp: new Date().toISOString(),
        reason
    }, dashboardClients);

    logger.info('device_disconnected', { deviceId: ws.deviceId, reason });
}

module.exports = { handleDeviceDisconnect };
