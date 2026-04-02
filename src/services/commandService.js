const pool = require('../config/db');
const logger = require('../utils/logger');

function isMissingRequestedByColumnsError(error) {
    return error && (
        error.code === 'ER_BAD_FIELD_ERROR'
        || /requested_by_user_id|requested_by_label/i.test(error.message || '')
    );
}

const sendCommand = async (deviceId, command, payload = null, activeDevices, options = {}) => {
    const active = activeDevices.get(deviceId);
    const requestedByUserId = options.requestedByUserId || null;
    const requestedByLabel = options.requestedByLabel || null;
    const fallbackRequestedBy = requestedByLabel || (requestedByUserId ? String(requestedByUserId) : null);
    let result;

    try {
        [result] = await pool.execute(
            `INSERT INTO commands (device_id, session_id, requested_by_user_id, requested_by_label, command, payload, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [
                deviceId,
                active?.sessionId ?? null,
                requestedByUserId,
                requestedByLabel,
                command,
                JSON.stringify(payload || null)
            ]
        );
    } catch (error) {
        if (!isMissingRequestedByColumnsError(error)) {
            throw error;
        }

        [result] = await pool.execute(
            `INSERT INTO commands (device_id, session_id, requested_by, command, payload, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [
                deviceId,
                active?.sessionId ?? null,
                fallbackRequestedBy,
                command,
                JSON.stringify(payload || null)
            ]
        );
    }

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

        logger.info('command_sent', { deviceId, commandId, command, requestedByUserId, requestedByLabel });
    } else {
        logger.info('command_queued_offline', { deviceId, commandId, command, requestedByUserId, requestedByLabel });
    }

    return commandId;
};

module.exports = { sendCommand };
