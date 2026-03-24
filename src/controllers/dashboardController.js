const pool = require('../config/db');
const logger = require('../utils/logger');
const { generateDeviceReport } = require('../services/reportService');

const getAllDevices = async (req, res) => {
    const [rows] = await pool.execute(`
        SELECT d.id, d.imei, d.online, d.last_seen, d.device_name, g.name as group_name
        FROM devices d LEFT JOIN groups g ON g.id = d.group_id
    `);
    res.json(rows);
};

const getDeviceById = async (req, res) => {
    const deviceId = req.params.id;
    const [rows] = await pool.execute(`
        SELECT d.id, d.device_name, d.imei, d.online, d.last_seen, g.name AS group_name, d.fixer_enabled
        FROM devices d LEFT JOIN groups g ON g.id = d.group_id WHERE d.id = ?
    `, [deviceId]);

    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
};

const getDeviceCommands = async (req, res) => {
    const deviceId = req.params.id;
    const [rows] = await pool.execute(`
        SELECT id, command, status, created_at FROM commands 
        WHERE device_id = ? ORDER BY created_at DESC LIMIT 50
    `, [deviceId]);
    res.json(rows);
};

const sendDashboardCommand = async (req, res) => {
    const { deviceId, command, payload } = req.body;
    if (!deviceId || !command) return res.status(400).json({ error: 'Missing data' });

    try {
        const activeDevices = req.app.locals.activeDevices;
        const [result] = await pool.execute(`
            INSERT INTO commands (device_id, command, payload, status) VALUES (?, ?, ?, 'pending')
        `, [deviceId, command, JSON.stringify(payload || null)]);

        const commandId = result.insertId;

        const active = activeDevices.get(Number(deviceId));
        if (active) {
            active.ws.send(JSON.stringify({
                type: 'command',
                command_id: commandId,
                command,
                payload: payload || null
            }));
            await pool.execute(`UPDATE commands SET status='sent' WHERE id=?`, [commandId]);
        }

        res.json({ status: 'ok', commandId });
    } catch (err) {
        logger.error('dashboard_command_error', { deviceId, error: err.message });
        res.status(500).json({ error: 'Server error' });
    }
};

const getCpuFrequencies = async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    if (!deviceId || isNaN(deviceId)) return res.status(400).json({ status: 'error', message: 'Invalid deviceId' });

    const { start, end, core = 'both', resolution = 'raw' } = req.query;
    let startTs = start ? BigInt(start) : BigInt(Date.now() - 24 * 60 * 60 * 1000);
    let endTs   = end   ? BigInt(end)   : BigInt(Date.now());

    try {
        const [rows] = await pool.execute(`
            SELECT core_type, segment_start AS ts_start, segment_end AS ts_end, frequency_khz
            FROM cpu_frequency_segments
            WHERE device_id = ? AND segment_start < ? AND segment_end > ?
            ORDER BY core_type, segment_start
        `, [deviceId, endTs, startTs]);

        const smallData = [];
        const bigData = [];

        rows.forEach(row => {
            const tsStart = Number(row.ts_start);
            const tsEnd   = Number(row.ts_end);
            const freq    = Number(row.frequency_khz);
            const points = [[tsStart, freq], [tsEnd, freq]];

            if (row.core_type === 'small') smallData.push(...points);
            else if (row.core_type === 'big') bigData.push(...points);
        });

        const series = [];
        if (core === 'small' || core === 'both') {
            series.push({ name: 'Small cores', type: 'line', step: 'middle', data: smallData });
        }
        if (core === 'big' || core === 'both') {
            series.push({ name: 'Big cores', type: 'line', step: 'middle', data: bigData });
        }

        res.json({
            status: 'ok',
            deviceId,
            from: Number(startTs),
            to: Number(endTs),
            series,
            segmentsCount: rows.length,
            uniqueFrequencies: [...new Set(rows.map(r => Number(r.frequency_khz)))].sort((a,b)=>a-b)
        });
    } catch (err) {
        logger.error('api_cpu_frequencies_error', { deviceId, error: err.message });
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
};

const getDeviceStats = async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    try {
        const [stats] = await pool.execute(`
            SELECT id, boot_time, collected_at FROM device_stats 
            WHERE device_id = ? ORDER BY collected_at DESC LIMIT 1
        `, [deviceId]);

        if (!stats.length) return res.json({ status: 'ok', data: null });

        const statId = stats[0].id;

        const [appStats] = await pool.execute(`
            SELECT a.package_name, a.app_name, das.cpu_time_sec, das.battery_pct, 
                   das.received_mb, das.transmitted_mb
            FROM device_app_stats das JOIN applications a ON a.id = das.application_id
            WHERE das.device_stat_id = ? ORDER BY das.cpu_time_sec DESC
        `, [statId]);

        const [crashes] = await pool.execute(`
            SELECT a.package_name, a.app_name, dac.crash_time, dac.reason
            FROM device_app_crashes dac JOIN applications a ON a.id = dac.application_id
            WHERE dac.device_stat_id = ? ORDER BY dac.crash_time DESC
        `, [statId]);

        res.json({
            status: 'ok',
            deviceId,
            boot_time: stats[0].boot_time,
            collected_at: stats[0].collected_at,
            apps: appStats,
            crashes
        });
    } catch (err) {
        logger.error('get_device_stats_error', { deviceId, error: err.message });
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
};

const getLicences = async (req, res) => {
    const [rows] = await pool.query(`
        SELECT id, device_token, imei, device_name, device_mac FROM devices ORDER BY device_name ASC
    `);
    res.json(rows);
};

const generateReport = async (req, res) => {
    await generateDeviceReport(res);
};

module.exports = {
    getAllDevices,
    getDeviceById,
    getDeviceCommands,
    sendDashboardCommand,
    getCpuFrequencies,
    getDeviceStats,
    getLicences,
    generateReport
};
