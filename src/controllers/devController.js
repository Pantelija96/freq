const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { sendCommand } = require('../services/commandService');

const logDir = path.resolve(process.cwd(), config.devTools.logDir);
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;

function getSafeLineCount(rawValue) {
    const parsed = parseInt(rawValue, 10);
    if (!parsed || Number.isNaN(parsed)) {
        return DEFAULT_LOG_LINES;
    }

    return Math.min(Math.max(parsed, 1), MAX_LOG_LINES);
}

async function getDevOverview(req, res) {
    res.json({
        status: 'ok',
        message: 'Developer helper endpoints are enabled',
        endpoints: {
            devices: 'GET /api/dev/devices',
            activeDevices: 'GET /api/dev/active-devices',
            sendDeviceCommand: 'POST /api/dev/devices/:deviceId/commands',
            sendGroupCommand: 'POST /api/dev/groups/:groupId/commands',
            recentCommands: 'GET /api/dev/devices/:deviceId/commands?limit=20',
            logs: 'GET /api/dev/logs',
            tailLog: 'GET /api/dev/logs/:filename?lines=200'
        }
    });
}

async function listDevices(req, res) {
    try {
        const [rows] = await pool.execute(`
            SELECT d.id, d.imei, d.device_name, d.online, d.last_seen, d.device_mac, d.device_ip,
                   d.fixer_enabled, g.name AS group_name
            FROM devices d
            LEFT JOIN groups g ON g.id = d.group_id
            ORDER BY d.device_name ASC, d.id ASC
        `);

        const activeDevices = req.app.locals.activeDevices;
        const devices = rows.map((device) => {
            const activeSession = activeDevices.get(device.id);
            return {
                ...device,
                websocket_connected: Boolean(activeSession),
                session_id: activeSession?.sessionId || null
            };
        });

        res.json({
            status: 'ok',
            total: devices.length,
            devices
        });
    } catch (err) {
        logger.error('dev_list_devices_failed', { error: err.message });
        res.status(500).json({ error: 'Failed to list devices' });
    }
}

async function listActiveDevices(req, res) {
    const activeDevices = req.app.locals.activeDevices;
    const sessions = Array.from(activeDevices.entries()).map(([deviceId, session]) => ({
        device_id: deviceId,
        session_id: session.sessionId
    }));

    res.json({
        status: 'ok',
        total: sessions.length,
        sessions
    });
}

async function sendDeviceCommand(req, res) {
    const deviceId = parseInt(req.params.deviceId, 10);
    const { type, payload = null } = req.body;

    if (!deviceId || Number.isNaN(deviceId)) {
        return res.status(400).json({ error: 'Invalid deviceId' });
    }

    if (!type || typeof type !== 'string') {
        return res.status(400).json({ error: 'Missing command type' });
    }

    try {
        const [devices] = await pool.execute(
            `SELECT id, device_name, online FROM devices WHERE id = ? LIMIT 1`,
            [deviceId]
        );

        if (!devices.length) {
            return res.status(404).json({ error: 'Device not found' });
        }

        const commandId = await sendCommand(deviceId, type, payload, req.app.locals.activeDevices);
        const active = req.app.locals.activeDevices.get(deviceId);

        res.json({
            status: 'command_created',
            command_id: commandId,
            device: devices[0],
            delivery: active ? 'sent_to_connected_device' : 'queued_for_offline_device'
        });
    } catch (err) {
        logger.error('dev_send_device_command_failed', { deviceId, type, error: err.message });
        res.status(500).json({ error: 'Failed to send command' });
    }
}

async function sendGroupCommand(req, res) {
    const groupId = parseInt(req.params.groupId, 10);
    const { type, payload = null } = req.body;

    if (!groupId || Number.isNaN(groupId)) {
        return res.status(400).json({ error: 'Invalid groupId' });
    }

    if (!type || typeof type !== 'string') {
        return res.status(400).json({ error: 'Missing command type' });
    }

    try {
        const [devices] = await pool.execute(
            `SELECT id, device_name FROM devices WHERE group_id = ? ORDER BY id ASC`,
            [groupId]
        );

        if (!devices.length) {
            return res.status(404).json({ error: 'No devices found for this group' });
        }

        const commands = [];
        for (const device of devices) {
            const commandId = await sendCommand(device.id, type, payload, req.app.locals.activeDevices);
            commands.push({
                device_id: device.id,
                device_name: device.device_name,
                command_id: commandId,
                delivery: req.app.locals.activeDevices.has(device.id)
                    ? 'sent_to_connected_device'
                    : 'queued_for_offline_device'
            });
        }

        res.json({
            status: 'group_command_created',
            total_devices: commands.length,
            commands
        });
    } catch (err) {
        logger.error('dev_send_group_command_failed', { groupId, type, error: err.message });
        res.status(500).json({ error: 'Failed to send group command' });
    }
}

async function listDeviceCommands(req, res) {
    const deviceId = parseInt(req.params.deviceId, 10);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    if (!deviceId || Number.isNaN(deviceId)) {
        return res.status(400).json({ error: 'Invalid deviceId' });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT id, session_id, command, payload, status, result, error_message, created_at, updated_at, executed_at
             FROM commands
             WHERE device_id = ?
             ORDER BY id DESC
             LIMIT ?`,
            [deviceId, limit]
        );

        const commands = rows.map((row) => ({
            ...row,
            payload: parseJsonSafe(row.payload),
            result: parseJsonSafe(row.result)
        }));

        res.json({
            status: 'ok',
            total: commands.length,
            commands
        });
    } catch (err) {
        logger.error('dev_list_device_commands_failed', { deviceId, error: err.message });
        res.status(500).json({ error: 'Failed to load device commands' });
    }
}

async function listLogs(req, res) {
    try {
        const entries = await fs.readdir(logDir, { withFileTypes: true });
        const files = [];

        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }

            const fullPath = path.join(logDir, entry.name);
            const stats = await fs.stat(fullPath);
            files.push({
                name: entry.name,
                size: stats.size,
                last_modified: stats.mtime.toISOString(),
                readable_text: /\.(log|json)$/i.test(entry.name)
            });
        }

        files.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        res.json({
            status: 'ok',
            total: files.length,
            files
        });
    } catch (err) {
        logger.error('dev_list_logs_failed', { error: err.message, logDir });
        res.status(500).json({ error: 'Failed to list logs' });
    }
}

async function readLogFile(req, res) {
    const requestedFile = req.params.filename;
    const safeFileName = path.basename(requestedFile);
    const fullPath = path.resolve(logDir, safeFileName);

    if (fullPath !== path.join(logDir, safeFileName)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!/\.(log|json)$/i.test(safeFileName)) {
        return res.status(400).json({ error: 'Only .log and .json files can be previewed' });
    }

    try {
        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content.split(/\r?\n/);
        const take = getSafeLineCount(req.query.lines);
        const tail = lines.slice(-take);

        res.json({
            status: 'ok',
            filename: safeFileName,
            lines_requested: take,
            total_lines: lines.length,
            content: tail.join('\n')
        });
    } catch (err) {
        if (err.code === 'ENOENT') {
            return res.status(404).json({ error: 'Log file not found' });
        }

        logger.error('dev_read_log_failed', { error: err.message, file: safeFileName });
        res.status(500).json({ error: 'Failed to read log file' });
    }
}

function parseJsonSafe(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

module.exports = {
    getDevOverview,
    listDevices,
    listActiveDevices,
    sendDeviceCommand,
    sendGroupCommand,
    listDeviceCommands,
    listLogs,
    readLogFile
};
