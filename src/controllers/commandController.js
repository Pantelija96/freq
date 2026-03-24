const pool = require('../config/db');
const logger = require('../utils/logger');
const { sendCommand } = require('../services/commandService');

const createCommand = async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const { type, payload } = req.body;

    if (!deviceId || isNaN(deviceId)) {
        return res.status(400).json({ error: 'Invalid deviceId' });
    }
    if (!type) {
        return res.status(400).json({ error: 'Missing command type' });
    }

    try {
        // activeDevices will be injected from server.js for now (we will improve later)
        const commandId = await sendCommand(deviceId, type, payload, req.app.locals.activeDevices);
        res.json({ status: 'command_created', command_id: commandId });
    } catch (err) {
        logger.error('command_create_error', { deviceId, error: err.message });
        res.status(500).json({ error: 'Command creation failed' });
    }
};

const createGroupCommand = async (req, res) => {
    const groupId = parseInt(req.params.groupId);
    const { type, payload } = req.body;

    if (!type) return res.status(400).json({ error: 'Missing command type' });

    try {
        const [devices] = await pool.execute(`SELECT id FROM devices WHERE group_id=?`, [groupId]);
        const results = [];

        for (const device of devices) {
            const commandId = await sendCommand(device.id, type, payload, req.app.locals.activeDevices);
            results.push({ deviceId: device.id, commandId });
        }

        res.json({
            status: 'group_command_created',
            total_devices: devices.length,
            commands: results
        });
    } catch (err) {
        logger.error('group_command_error', { groupId, error: err.message });
        res.status(500).json({ error: 'Group command failed' });
    }
};

const cancelCommand = async (req, res) => {
    const commandId = parseInt(req.params.id);

    try {
        const [rows] = await pool.execute(`SELECT device_id, status FROM commands WHERE id=?`, [commandId]);
        if (!rows.length) return res.status(404).json({ error: 'Command not found' });

        const cmd = rows[0];
        if (!['pending','sent'].includes(cmd.status)) {
            return res.status(400).json({ error: 'Command already processed' });
        }

        await pool.execute(`UPDATE commands SET status='cancelled' WHERE id=?`, [commandId]);

        logger.info('command_cancelled', { commandId, deviceId: cmd.device_id });

        res.json({ status: 'cancelled', command_id: commandId });
    } catch (err) {
        logger.error('command_cancel_error', { commandId, error: err.message });
        res.status(500).json({ error: 'Cancel failed' });
    }
};

module.exports = { createCommand, createGroupCommand, cancelCommand };
