const pool = require('../config/db');
const logger = require('../utils/logger');
const { buildFrequencyAnalytics } = require('../services/frequencyAnalyticsService');
const { listLicences } = require('../services/licenceService');
const { generateDeviceReport } = require('../services/reportService');
const { sendCommand } = require('../services/commandService');

const getOverview = async (req, res) => {
    try {
        const [[deviceCounts]] = await pool.execute(`
            SELECT
                COUNT(*) AS total_devices,
                SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online_devices
            FROM devices
        `);

        const [[groupsCount]] = await pool.execute(`
            SELECT COUNT(*) AS total_groups
            FROM groups
        `);

        const [[commandsToday]] = await pool.execute(`
            SELECT COUNT(*) AS commands_today
            FROM commands
            WHERE created_at >= CURRENT_DATE()
        `);

        res.json({
            total_devices: Number(deviceCounts.total_devices || 0),
            online_devices: Number(deviceCounts.online_devices || 0),
            total_groups: Number(groupsCount.total_groups || 0),
            commands_today: Number(commandsToday.commands_today || 0)
        });
    } catch (err) {
        logger.error('dashboard_overview_error', { error: err.message });
        res.status(500).json({ error: 'Failed to load dashboard overview' });
    }
};

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
        const requestedByUserId = Number(req.auth?.user?.id || req.auth?.user?.sub) || null;
        const commandId = await sendCommand(deviceId, command, payload, activeDevices, {
            requestedByUserId
        });

        res.json({ status: 'ok', commandId });
    } catch (err) {
        logger.error('dashboard_command_error', { deviceId, error: err.message });
        res.status(500).json({ error: 'Server error' });
    }
};

async function loadFrequencyRows(deviceId, endTs, startTs) {
    const [rows] = await pool.execute(`
        SELECT core_type, segment_start AS ts_start, segment_end AS ts_end, frequency_khz
        FROM cpu_frequency_segments
        WHERE device_id = ? AND segment_start < ? AND segment_end > ?
        ORDER BY core_type, segment_start
    `, [deviceId, endTs, startTs]);

    return rows;
}

const getCpuFrequencies = async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    if (!deviceId || isNaN(deviceId)) return res.status(400).json({ status: 'error', message: 'Invalid deviceId' });

    const { start, end, core = 'both', resolution = 'raw' } = req.query;
    let startTs = start ? BigInt(start) : BigInt(Date.now() - 24 * 60 * 60 * 1000);
    let endTs   = end   ? BigInt(end)   : BigInt(Date.now());

    try {
        let rows = await loadFrequencyRows(deviceId, endTs, startTs);

        if (!start && !end && rows.length === 0) {
            const [[latestSegment]] = await pool.execute(`
                SELECT MAX(segment_end) AS latest_segment_end
                FROM cpu_frequency_segments
                WHERE device_id = ?
            `, [deviceId]);

            if (latestSegment?.latest_segment_end) {
                endTs = BigInt(latestSegment.latest_segment_end);
                startTs = endTs - BigInt(24 * 60 * 60 * 1000);
                rows = await loadFrequencyRows(deviceId, endTs, startTs);
            }
        }

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

        const [crashRows] = await pool.execute(`
            SELECT dac.crash_time, dac.reason, a.package_name, a.app_name
            FROM device_app_crashes dac
            INNER JOIN device_stats ds ON ds.id = dac.device_stat_id
            INNER JOIN applications a ON a.id = dac.application_id
            WHERE ds.device_id = ?
              AND dac.crash_time BETWEEN FROM_UNIXTIME(? / 1000) AND FROM_UNIXTIME(? / 1000)
            ORDER BY dac.crash_time DESC
        `, [deviceId, Number(startTs), Number(endTs)]);

        const analytics = buildFrequencyAnalytics(
            rows.map((row) => ({
                core_type: row.core_type,
                segment_start: row.ts_start,
                segment_end: row.ts_end,
                frequency_khz: row.frequency_khz
            })),
            crashRows
        );

        res.json({
            status: 'ok',
            deviceId,
            from: Number(startTs),
            to: Number(endTs),
            series,
            segmentsCount: rows.length,
            uniqueFrequencies: [...new Set(rows.map(r => Number(r.frequency_khz)))].sort((a,b)=>a-b),
            summary: analytics.summary,
            fixed_sessions: analytics.fixedSessions
        });
    } catch (err) {
        logger.error('api_cpu_frequencies_error', { deviceId, error: err.message });
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
};

const getDeviceStats = async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    try {
        let [stats] = await pool.execute(`
            SELECT ds.id, ds.boot_time, ds.collected_at
            FROM device_stats ds
            WHERE ds.device_id = ?
              AND (
                EXISTS (SELECT 1 FROM device_app_stats das WHERE das.device_stat_id = ds.id)
                OR EXISTS (SELECT 1 FROM device_app_crashes dac WHERE dac.device_stat_id = ds.id)
              )
            ORDER BY ds.collected_at DESC
            LIMIT 1
        `, [deviceId]);

        if (!stats.length) {
            [stats] = await pool.execute(`
                SELECT id, boot_time, collected_at FROM device_stats 
                WHERE device_id = ? ORDER BY collected_at DESC LIMIT 1
            `, [deviceId]);
        }

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

        const [frequencyRows] = await pool.execute(`
            SELECT core_type, segment_start, segment_end, frequency_khz
            FROM cpu_frequency_segments
            WHERE device_id = ?
            ORDER BY segment_start ASC
        `, [deviceId]);

        const analytics = buildFrequencyAnalytics(frequencyRows, crashes);

        res.json({
            status: 'ok',
            deviceId,
            boot_time: stats[0].boot_time,
            collected_at: stats[0].collected_at,
            apps: appStats,
            crashes,
            crash_summary: {
                during_fixed: analytics.summary.crashes_during_fixed,
                outside_fixed: analytics.summary.crashes_outside_fixed
            }
        });
    } catch (err) {
        logger.error('get_device_stats_error', { deviceId, error: err.message });
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
};

const getLicences = async (req, res) => {
    try {
        const rows = await listLicences();
        res.json(rows);
    } catch (err) {
        logger.error('get_licences_error', { error: err.message });
        res.status(500).json({ error: 'Failed to load licences' });
    }
};

const generateReport = async (req, res) => {
    try {
        const deviceIds = Array.isArray(req.body?.deviceIds)
            ? req.body.deviceIds
            : req.query.deviceIds;
        await generateDeviceReport(res, {
            deviceIds,
            requestedBy: req.auth?.user || null
        });
    } catch (err) {
        logger.error('generate_report_error', { error: err.message });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate report' });
        }
    }
};

module.exports = {
    getOverview,
    getAllDevices,
    getDeviceById,
    getDeviceCommands,
    sendDashboardCommand,
    getCpuFrequencies,
    getDeviceStats,
    getLicences,
    generateReport
};
