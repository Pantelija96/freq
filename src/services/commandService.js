const pool = require('../config/db');
const logger = require('../utils/logger');

const sendCommand = async (deviceId, command, payload = null, activeDevices, options = {}) => {
    const active = activeDevices.get(deviceId);
    const requestedBy = options.requestedBy || null;

    const [result] = await pool.execute(
        `INSERT INTO commands (device_id, session_id, requested_by, command, payload, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [deviceId, active?.sessionId ?? null, requestedBy, command, JSON.stringify(payload || null)]
    );

    const commandId = result.insertId;

    // broadcastToDashboard will be passed from controller later
    if (active) {
        active.ws.send(JSON.stringify({
            type: 'command',
            command_id: commandId,
            command,
            payload: payload || null
        }));

        await pool.execute(`UPDATE commands SET status='sent' WHERE id=?`, [commandId]);

        logger.info('command_sent', { deviceId, commandId, command, requestedBy });
    } else {
        logger.info('command_queued_offline', { deviceId, commandId, command, requestedBy });
    }

    return commandId;
};

module.exports = { sendCommand };
