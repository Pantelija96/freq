const pool = require('../config/db');
const logger = require('../utils/logger');

async function processStatsPayload(deviceId, payload, broadcastDeviceStatsFn) {
    const { boot_time, apps = [], crashes = [], fixed = null } = payload;
    if (!boot_time) return;

    try {
        const [statResult] = await pool.execute(
            `INSERT INTO device_stats (device_id, boot_time, fixed) VALUES (?, ?, ?)`,
            [deviceId, boot_time, fixed]
        );

        const deviceStatId = statResult.insertId;
        const packages = new Set();
        apps.forEach(a => { if (a.package) packages.add(a.package); });
        crashes.forEach(c => { if (c.package) packages.add(c.package); });

        const packageList = Array.from(packages);
        let appMap = new Map();

        if (packageList.length > 0) {
            const placeholders = packageList.map(() => '?').join(',');
            const [rows] = await pool.execute(
                `SELECT id, package_name FROM applications WHERE package_name IN (${placeholders})`,
                packageList
            );
            rows.forEach(row => appMap.set(row.package_name, row.id));
        }

        for (const pkg of packageList) {
            if (!appMap.has(pkg)) {
                const [insertRes] = await pool.execute(
                    `INSERT INTO applications (package_name, app_name) VALUES (?, ?)`,
                    [pkg, pkg]
                );
                appMap.set(pkg, insertRes.insertId);
            }
        }

        const appStatsRows = apps.map(app => {
            const applicationId = appMap.get(app.package);
            return applicationId ? [
                deviceStatId,
                applicationId,
                Number(app.cpu_time || 0),
                Number(app.battery_pct || 0),
                Number(app.received_mb || 0),
                Number(app.transmitted_mb || 0)
            ] : null;
        }).filter(Boolean);

        if (appStatsRows.length) {
            await pool.query(
                `INSERT INTO device_app_stats 
                 (device_stat_id, application_id, cpu_time_sec, battery_pct, received_mb, transmitted_mb) VALUES ?`,
                [appStatsRows]
            );
        }

        const crashRows = crashes.map(crash => {
            if (!crash.time || !crash.package) return null;
            const applicationId = appMap.get(crash.package);
            if (!applicationId) return null;
            const crashTime = parseAndroidCrashTime(crash.time);
            return [deviceStatId, applicationId, crashTime, crash.reason || null];
        }).filter(Boolean);

        if (crashRows.length) {
            await pool.query(
                `INSERT INTO device_app_crashes (device_stat_id, application_id, crash_time, reason) VALUES ?`,
                [crashRows]
            );
        }

        logger.info('stats_processed_successfully', {
            deviceId, boot_time, appsCount: apps.length, crashesCount: crashes.length, deviceStatId
        });

        if (broadcastDeviceStatsFn) broadcastDeviceStatsFn(deviceId);
    } catch (err) {
        logger.error('processStatsPayload_failed', { deviceId, error: err.message });
    }
}

function parseAndroidCrashTime(timeStr) {
    const year = new Date().getFullYear();
    const [datePart, timePart] = timeStr.split(" ");
    const [month, day] = datePart.split("-");
    const cleanTime = timePart.split(".")[0];
    return `${year}-${month}-${day} ${cleanTime}`;
}

async function broadcastDeviceStats(deviceId, broadcastFn) {
    const [stats] = await pool.execute(`
        SELECT id, boot_time, collected_at FROM device_stats 
        WHERE device_id = ? ORDER BY collected_at DESC LIMIT 1
    `, [deviceId]);

    if (!stats.length) return;

    const statId = stats[0].id;

    const [apps] = await pool.execute(`
        SELECT a.package_name, a.app_name, das.cpu_time_sec, das.battery_pct, das.received_mb, das.transmitted_mb
        FROM device_app_stats das JOIN applications a ON a.id = das.application_id
        WHERE das.device_stat_id = ? ORDER BY das.cpu_time_sec DESC
    `, [statId]);

    const [crashes] = await pool.execute(`
        SELECT a.package_name, a.app_name, dac.crash_time, dac.reason
        FROM device_app_crashes dac JOIN applications a ON a.id = dac.application_id
        WHERE dac.device_stat_id = ? ORDER BY dac.crash_time DESC
    `, [statId]);

    broadcastFn({
        type: "device_stats",
        deviceId,
        apps,
        crashes,
        collected_at: stats[0].collected_at
    });
}

module.exports = {
    processStatsPayload,
    parseAndroidCrashTime,
    broadcastDeviceStats
};
