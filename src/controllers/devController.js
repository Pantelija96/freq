const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { sendCommand } = require('../services/commandService');
const { buildLicenceKey } = require('../services/licenceService');

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
            seedDemoData: 'GET /api/dev/seed/demo',
            logs: 'GET /api/dev/logs',
            tailLog: 'GET /api/dev/logs/:filename?lines=200'
        }
    });
}

async function seedDemoData(req, res) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const groupIds = await ensureGroups(connection, ['Alpha', 'Beta', 'Gamma']);
        const appIds = await ensureApplications(connection, [
            { packageName: 'com.spotify.music', appName: 'Spotify' },
            { packageName: 'com.instagram.android', appName: 'Instagram' },
            { packageName: 'com.whatsapp', appName: 'WhatsApp' },
            { packageName: 'com.google.android.youtube', appName: 'YouTube' }
        ]);

        const now = new Date();
        const devices = await upsertDemoDevices(connection, groupIds, now);
        await seedLicences(connection, devices);

        for (const device of devices) {
            await seedCommands(connection, device.id, now);
            await seedStats(connection, device.id, appIds, now);
            await seedFrequencySegments(connection, device.id, now);
        }

        await connection.commit();

        res.json({
            status: 'ok',
            message: 'Demo dashboard data inserted',
            groups_created: Object.keys(groupIds).length,
            devices_seeded: devices.length,
            licences_seeded: devices.length
        });
    } catch (err) {
        await connection.rollback();
        logger.error('dev_seed_demo_failed', { error: err.message });
        res.status(500).json({ error: 'Failed to seed demo data' });
    } finally {
        connection.release();
    }
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

        const commandId = await sendCommand(deviceId, type, payload, req.app.locals.activeDevices, {
            requestedByLabel: 'dev-tools'
        });
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
            const commandId = await sendCommand(device.id, type, payload, req.app.locals.activeDevices, {
                requestedByLabel: 'dev-tools'
            });
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
        let rows;

        try {
            [rows] = await pool.execute(
                `SELECT
                    c.id,
                    c.session_id,
                    c.requested_by_user_id,
                    c.requested_by_label,
                    COALESCE(
                        NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), ''),
                        u.username,
                        c.requested_by_label
                    ) AS requested_by,
                    c.command,
                    c.payload,
                    c.status,
                    c.result,
                    c.error_message,
                    c.created_at,
                    c.updated_at,
                    c.executed_at
                 FROM commands c
                 LEFT JOIN users u ON u.id = c.requested_by_user_id
                 WHERE c.device_id = ?
                 ORDER BY c.id DESC
                 LIMIT ?`,
                [deviceId, limit]
            );
        } catch (error) {
            if (!isMissingRequestedByColumnsError(error)) {
                throw error;
            }

            [rows] = await pool.execute(
                `SELECT
                    id,
                    session_id,
                    requested_by AS requested_by_label,
                    requested_by,
                    command,
                    payload,
                    status,
                    result,
                    error_message,
                    created_at,
                    updated_at,
                    executed_at
                 FROM commands
                 WHERE device_id = ?
                 ORDER BY id DESC
                 LIMIT ?`,
                [deviceId, limit]
            );
        }

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

function isMissingRequestedByColumnsError(error) {
    return error && (
        error.code === 'ER_BAD_FIELD_ERROR'
        || /requested_by_user_id|requested_by_label/i.test(error.message || '')
    );
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

async function ensureGroups(connection, groupNames) {
    const ids = {};

    for (const groupName of groupNames) {
        let [[row]] = await connection.execute(
            `SELECT id FROM groups WHERE name = ? LIMIT 1`,
            [groupName]
        );

        if (!row) {
            const [insertResult] = await connection.execute(
                `INSERT INTO groups (name) VALUES (?)`,
                [groupName]
            );
            row = { id: insertResult.insertId };
        }

        ids[groupName] = row.id;
    }

    return ids;
}

async function ensureApplications(connection, apps) {
    const ids = {};

    for (const app of apps) {
        await connection.execute(
            `INSERT INTO applications (package_name, app_name)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE app_name = VALUES(app_name)`,
            [app.packageName, app.appName]
        );

        const [[row]] = await connection.execute(
            `SELECT id FROM applications WHERE package_name = ? LIMIT 1`,
            [app.packageName]
        );
        ids[app.packageName] = row.id;
    }

    return ids;
}

async function upsertDemoDevices(connection, groupIds, now) {
    const demoDevices = [
        { imei: '860000000000101', deviceName: 'Alpha Node 01', groupName: 'Alpha', online: 1, fixerEnabled: 1, mac: 'AA:10:00:00:00:01', ip: '10.10.0.11' },
        { imei: '860000000000102', deviceName: 'Alpha Node 02', groupName: 'Alpha', online: 0, fixerEnabled: 0, mac: 'AA:10:00:00:00:02', ip: '10.10.0.12' },
        { imei: '860000000000201', deviceName: 'Beta Node 01', groupName: 'Beta', online: 1, fixerEnabled: 1, mac: 'BB:20:00:00:00:01', ip: '10.20.0.11' },
        { imei: '860000000000202', deviceName: 'Beta Node 02', groupName: 'Beta', online: 1, fixerEnabled: 0, mac: 'BB:20:00:00:00:02', ip: '10.20.0.12' },
        { imei: '860000000000301', deviceName: 'Gamma Node 01', groupName: 'Gamma', online: 0, fixerEnabled: 1, mac: 'CC:30:00:00:00:01', ip: '10.30.0.11' }
    ];

    for (const demo of demoDevices) {
        await connection.execute(
            `INSERT INTO devices (
                imei, device_name, group_id, device_token, device_mac, device_ip, last_seen, online, fixer_enabled
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                device_name = VALUES(device_name),
                group_id = VALUES(group_id),
                device_mac = VALUES(device_mac),
                device_ip = VALUES(device_ip),
                last_seen = VALUES(last_seen),
                online = VALUES(online),
                fixer_enabled = VALUES(fixer_enabled)`,
            [
                demo.imei,
                demo.deviceName,
                groupIds[demo.groupName],
                `demo-token-${demo.imei}`,
                demo.mac,
                demo.ip,
                now,
                demo.online,
                demo.fixerEnabled
            ]
        );
    }

    const imeis = demoDevices.map((device) => device.imei);
    const placeholders = imeis.map(() => '?').join(', ');
    const [rows] = await connection.query(
        `SELECT id, imei, device_name FROM devices WHERE imei IN (${placeholders}) ORDER BY id ASC`,
        imeis
    );

    return rows;
}

async function seedLicences(connection, devices) {
    for (const device of devices) {
        const licenceKey = buildLicenceKey(device.id, device.imei);
        await connection.execute(
            `INSERT INTO licences (device_id, licence_key)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE licence_key = VALUES(licence_key)`,
            [device.id, licenceKey]
        );
    }
}

async function seedCommands(connection, deviceId, now) {
    await connection.execute(`DELETE FROM commands WHERE device_id = ? AND created_at >= CURRENT_DATE()`, [deviceId]);

    const commandRows = [
        ['fix', 'done', null, JSON.stringify({ ok: true, note: 'Fix applied' }), new Date(now.getTime() - 1000 * 60 * 45)],
        ['stats', 'acknowledged', null, null, new Date(now.getTime() - 1000 * 60 * 20)],
        ['reset_mac', 'failed', 'Adapter reset denied by policy', null, new Date(now.getTime() - 1000 * 60 * 5)]
    ];

    for (const [command, status, errorMessage, result, createdAt] of commandRows) {
        await connection.execute(
            `INSERT INTO commands (device_id, requested_by_label, command, payload, status, result, error_message, created_at, updated_at, executed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                deviceId,
                'demo-seed',
                command,
                JSON.stringify({ source: 'demo-seed' }),
                status,
                result,
                errorMessage,
                createdAt,
                createdAt,
                createdAt
            ]
        );
    }
}

async function seedStats(connection, deviceId, appIds, now) {
    await connection.execute(
        `DELETE dac
         FROM device_app_crashes dac
         INNER JOIN device_stats ds ON ds.id = dac.device_stat_id
         WHERE ds.device_id = ?`,
        [deviceId]
    );
    await connection.execute(
        `DELETE das
         FROM device_app_stats das
         INNER JOIN device_stats ds ON ds.id = das.device_stat_id
         WHERE ds.device_id = ?`,
        [deviceId]
    );
    await connection.execute(`DELETE FROM device_stats WHERE device_id = ?`, [deviceId]);

    const bootTime = new Date(now.getTime() - 1000 * 60 * 60 * 5);

    const [statInsert] = await connection.execute(
        `INSERT INTO device_stats (device_id, boot_time, collected_at, fixed)
         VALUES (?, ?, ?, ?)`,
        [deviceId, bootTime, now, 1]
    );

    const statId = statInsert.insertId;

    const appStats = [
        [appIds['com.spotify.music'], 152.4, 8.7, 120.3, 14.8],
        [appIds['com.instagram.android'], 98.2, 6.1, 210.4, 33.2],
        [appIds['com.whatsapp'], 38.7, 2.4, 18.5, 9.1],
        [appIds['com.google.android.youtube'], 122.1, 7.5, 480.2, 41.0]
    ];

    for (const [applicationId, cpuTime, batteryPct, receivedMb, transmittedMb] of appStats) {
        await connection.execute(
            `INSERT INTO device_app_stats (
                device_stat_id, application_id, cpu_time_sec, battery_pct, received_mb, transmitted_mb
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [statId, applicationId, cpuTime, batteryPct, receivedMb, transmittedMb]
        );
    }

    const crashes = [
        [appIds['com.spotify.music'], new Date(now.getTime() - 1000 * 60 * 13), 'java.lang.IllegalStateException: Player init failed'],
        [appIds['com.instagram.android'], new Date(now.getTime() - 1000 * 60 * 8), 'java.lang.NullPointerException']
    ];

    for (const [applicationId, crashTime, reason] of crashes) {
        await connection.execute(
            `INSERT INTO device_app_crashes (device_stat_id, application_id, crash_time, reason)
             VALUES (?, ?, ?, ?)`,
            [statId, applicationId, crashTime, reason]
        );
    }
}

async function seedFrequencySegments(connection, deviceId, now) {
    const batchToken = `demo-${deviceId}-${now.getTime()}`;
    const intervalMs = 250;
    const smallValues = [576000, 576000, 691200, 998400, 1209600];
    const bigValues = [710400, 844800, 960000, 1075200, 1248000];
    const startBase = now.getTime() - 1000 * 60 * 30;

    await connection.execute(
        `DELETE FROM cpu_frequency_segments
         WHERE device_id = ? AND batch_id LIKE 'demo-%'`,
        [deviceId]
    );

    await insertFrequencySeries(connection, deviceId, batchToken, 'small', smallValues, startBase, intervalMs);
    await insertFrequencySeries(connection, deviceId, batchToken, 'big', bigValues, startBase, intervalMs);
}

async function insertFrequencySeries(connection, deviceId, batchId, coreType, frequencies, startBase, intervalMs) {
    for (let index = 0; index < frequencies.length; index += 1) {
        const segmentStart = startBase + index * intervalMs;
        const segmentEnd = segmentStart + intervalMs;

        await connection.execute(
            `INSERT IGNORE INTO cpu_frequency_segments (
                device_id, core_type, segment_start, segment_end, frequency_khz, batch_id
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [deviceId, coreType, segmentStart, segmentEnd, frequencies[index], batchId]
        );
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
    readLogFile,
    seedDemoData
};
