const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const pool = require('./db');
const crypto = require('crypto');
const logger = require('./logger');
const PDFDocument = require("pdfkit");

const app = express();
app.use(cors());
app.use(express.json());

const server = https.createServer({
    key: fs.readFileSync('./cert/server.key'),
    cert: fs.readFileSync('./cert/server.cert')
}, app);

const wss = new WebSocketServer({ server });

const dashboardClients = new Set();

const activeDevices = new Map();

const PING_INTERVAL = 30000;

const MAX_MISSED_PONGS = 3;

// HTTP ENDPOINTS

app.post('/provision', async (req, res) => {

    console.log('req.body', req.body);
    const { imei, group, app_list, device_name, device_mac } = req.body;

    const appsCount = app_list && typeof app_list === 'object' ? Object.keys(app_list).length : 0;

    logger.info('device_provision_request', {
        imei,
        group,
        device_name,
        device_mac,
        appsCount,
        ip: req.ip
    });

    if (!imei || !group || !app_list || !device_name ) {
        logger.warn('device_provision_invalid_payload', {
            imei,
            group,
            device_name,
            device_mac,
            appsCount,
            ip: req.ip
        });

        return res.status(400).json({ error: 'Invalid payload' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const deviceToken = crypto.randomBytes(32).toString('hex');

        await connection.execute(
            `INSERT INTO groups (name)
             VALUES (?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            [group]
        );
        const [groupRows] = await connection.execute(
            `SELECT id FROM groups WHERE name = ?`,
            [group]
        );
        const groupId = groupRows[0].id;


        const [deviceRows] = await connection.execute(
            `SELECT id, device_token FROM devices WHERE imei = ?`,
            [imei]
        );
        let deviceId;
        let finalToken = deviceToken;

        if (deviceRows.length === 0) {
            const [insertDevice] = await connection.execute(
                `INSERT INTO devices (imei, device_name, group_id, device_token, device_mac, device_ip)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [imei, device_name || null, groupId, deviceToken, device_mac, req.ip]
            );
            deviceId = insertDevice.insertId;
        } else {
            deviceId = deviceRows[0].id;
            finalToken = deviceRows[0].device_token;

            await connection.execute(
                `UPDATE devices
                 SET device_name = ?, group_id = ?
                 WHERE id = ?`,
                [device_name || null, groupId, deviceId]
            );
        }

        await connection.execute(
            `DELETE FROM device_apps WHERE device_id = ?`,
            [deviceId]
        );

        const packages = Object.keys(app_list);

        for (const pkg of packages) {
            const name = app_list[pkg];
            await connection.execute(
                `INSERT INTO applications (package_name, app_name)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE app_name = VALUES(app_name)`,
                [pkg, name]
            );

            const [appRows] = await connection.execute(
                `SELECT id FROM applications WHERE package_name = ?`,
                [pkg]
            );

            const appId = appRows[0].id;

            await connection.execute(
                `INSERT INTO device_apps (device_id, application_id)
                 VALUES (?, ?)`,
                [deviceId, appId]
            );
        }

        await connection.commit();

        logger.info('device_provision_success', {
            imei,
            deviceId,
            groupId,
            appsCount,
            tokenGenerated: deviceRows.length === 0
        });

        res.json({
            status: 'provisioned',
            device_token: finalToken
        });

    } catch (err) {

        await connection.rollback();
        logger.error('device_provision_failed', {
            imei,
            group,
            error: err.message,
            stack: err.stack?.substring(0, 500)
        });
        res.status(500).json({ error: 'Provision failed' });
    } finally {
        connection.release();
    }
});

app.post('/login', async (req, res) => {

    const { imei, device_token } = req.body;
    logger.info('device_login_attempt', {
        imei,
        ip: req.ip
    });

    if (!imei || !device_token) {
        logger.warn('device_login_invalid_payload', {
            imei,
            ip: req.ip
        });
        return res.status(400).json({
            status: 'error',
            error: 'Missing credentials'
        });
    }

    try {

        const [rows] = await pool.execute(
            `SELECT id, device_name
             FROM devices
             WHERE imei = ? AND device_token = ?
             LIMIT 1`,
            [imei, device_token]
        );

        if (!rows.length) {
            logger.warn('device_login_failed', {
                imei,
                ip: req.ip,
                reason: 'invalid_credentials'
            });
            return res.status(401).json({
                status: 'error',
                error: 'Invalid credentials'
            });
        }

        const device = rows[0];
        logger.info('device_login_success', {
            deviceId: device.id,
            imei,
            device_name: device.device_name,
            ip: req.ip
        });
        res.json({
            status: 'login_ok',
            device_id: device.id,
            // wss_url: 'wss://109.72.48.188:3000'
            wss_url: 'wss://192.168.1.4:3000'
        });
    } catch (err) {
        logger.error('device_login_error', {
            imei,
            ip: req.ip,
            error: err.message,
            stack: err.stack?.substring(0, 500)
        });
        res.status(500).json({
            status: 'error',
            error: 'Server error'
        });
    }

});

app.post('/command/:deviceId', async (req, res) => {

    if (!deviceId || isNaN(deviceId)) {
        return res.status(400).json({ error: 'Invalid deviceId' });
    }
    const { type, payload } = req.body;

    if (!type) {
        return res.status(400).json({ error: 'Missing command type' });
    }

    const commandId = await sendCommand(deviceId, type, payload);

    res.json({
        status: 'command_created',
        command_id: commandId
    });
});

app.post('/command/group/:groupId', async (req, res) => {

    const groupId = parseInt(req.params.groupId);
    const { type, payload } = req.body;

    if (!type) {
        return res.status(400).json({ error: 'Missing command type' });
    }

    const [devices] = await pool.execute(
        `SELECT id FROM devices WHERE group_id=?`,
        [groupId]
    );

    const results = [];

    for (const device of devices) {
        const commandId = await sendCommand(device.id, type, payload);
        results.push({ deviceId: device.id, commandId });
    }

    res.json({
        status: 'group_command_created',
        total_devices: devices.length,
        commands: results
    });
});

app.post('/command/cancel/:id', async (req, res) => {

    const commandId = parseInt(req.params.id);

    const [rows] = await pool.execute(
        `SELECT device_id, status
         FROM commands
         WHERE id=?`,
        [commandId]
    );

    if (!rows.length) {
        return res.status(404).json({ error: 'Command not found' });
    }

    const cmd = rows[0];

    if (!['pending','sent'].includes(cmd.status)) {
        return res.status(400).json({
            error: `Command already processed`
        });
    }

    await pool.execute(
        `UPDATE commands
         SET status='cancelled'
         WHERE id=?`,
        [commandId]
    );

    logger.info('command_cancelled', {
        commandId,
        deviceId: cmd.device_id
    });

    res.json({
        status: 'cancelled',
        command_id: commandId
    });
});

app.get('/dashboard/devices', async (req, res) => {
    const [rows] = await pool.execute(`
        SELECT d.id, d.imei, d.online, d.last_seen, d.device_name, g.name as group_name
        FROM devices d
        LEFT JOIN groups g ON g.id = d.group_id
    `);
    res.json(rows);
});

app.get('/dashboard/device/:id', async (req, res) => {
    try {
        const deviceId = req.params.id;

        const [rows] = await pool.execute(`
            SELECT 
                d.id,
                d.device_name,
                d.imei,
                d.online,
                d.last_seen,
                g.name AS group_name,
                d.fixer_enabled
            FROM devices d
            LEFT JOIN groups g ON g.id = d.group_id
            WHERE d.id = ?
        `, [deviceId]);

        if (!rows.length) {
            return res.status(404).json({ error: 'Device not found' });
        }

        res.json(rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/dashboard/command', async (req, res) => {
    try {
        const { deviceId, command, payload } = req.body;

        if (!deviceId || !command) {
            return res.status(400).json({ error: 'Missing data' });
        }

        const [result] = await pool.execute(`
            INSERT INTO commands (device_id, command, payload, status)
            VALUES (?, ?, ?, 'pending')
        `, [deviceId, command, JSON.stringify(payload || null)]);

        const commandId = result.insertId;

        const active = activeDevices.get(Number(deviceId));

        if (active) {
            active.ws.send(JSON.stringify({
                type: 'command',
                command_id: commandId,
                command: command,
                payload: payload || null
            }));

            await pool.execute(`
                UPDATE commands SET status='sent' WHERE id=?
            `, [commandId]);

            broadcastToDashboard({
                type: 'command_update',
                command: {
                    id: commandId,
                    device_id: deviceId,
                    command,
                    status: 'sent',
                    created_at: new Date()
                }
            });
        }

        res.json({ status: 'ok', commandId });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/dashboard/device/:id/commands', async (req, res) => {
    try {
        const deviceId = req.params.id;

        const [rows] = await pool.execute(`
            SELECT id, command, status, created_at
            FROM commands
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [deviceId]);

        res.json(rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/device/:deviceId/cpu-frequencies', async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    if (!deviceId || isNaN(deviceId)) {
        return res.status(400).json({ status: 'error', message: 'Invalid deviceId' });
    }

    const { start, end, core = 'both', resolution = 'raw' } = req.query;

    let startTs = 0;// start ? BigInt(start) : BigInt(Date.now() - 24 * 60 * 60 * 1000); // default poslednja 24h
    let endTs   = end   ? BigInt(end)   : BigInt(Date.now());

    try {
        let query = `
      SELECT 
        core_type,
        segment_start AS ts_start,
        segment_end   AS ts_end,
        frequency_khz
      FROM cpu_frequency_segments
      WHERE device_id = ?
        AND segment_start < ?
        AND segment_end   > ?
      ORDER BY core_type, segment_start
    `;

        const params = [deviceId, endTs, startTs];

        const [rows] = await pool.execute(query, params);

        // Grupisanje po core_type
        const smallData = [];
        const bigData   = [];

        rows.forEach(row => {
            const tsStart = Number(row.ts_start); // BigInt → Number (za ECharts)
            const tsEnd   = Number(row.ts_end);
            const freq    = Number(row.frequency_khz);

            const points = [
                [tsStart, freq],
                [tsEnd,   freq]
            ];

            if (row.core_type === 'small') {
                smallData.push(...points);
            } else if (row.core_type === 'big') {
                bigData.push(...points);
            }
        });

        const series = [];

        if (core === 'small' || core === 'both') {
            series.push({
                name: 'Small cores',
                type: 'line',
                step: 'middle',
                data: smallData
            });
        }

        if (core === 'big' || core === 'both') {
            series.push({
                name: 'Big cores',
                type: 'line',
                step: 'middle',
                data: bigData
            });
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
        logger.error('api_cpu_frequencies_error', {
            deviceId,
            error: err.message
        });
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

app.get('/device/:deviceId/stats', async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);

    try {
        const [stats] = await pool.execute(`
            SELECT id, boot_time, collected_at 
            FROM device_stats 
            WHERE device_id = ? 
            ORDER BY collected_at DESC 
            LIMIT 1
        `, [deviceId]);

        if (!stats.length) {
            return res.json({ status: 'ok', data: null });
        }

        const statId = stats[0].id;

        const [appStats] = await pool.execute(`
            SELECT 
                a.package_name,
                a.app_name,
                das.cpu_time_sec,
                das.battery_pct,
                das.received_mb,
                das.transmitted_mb
            FROM device_app_stats das
            JOIN applications a ON a.id = das.application_id
            WHERE das.device_stat_id = ?
            ORDER BY das.cpu_time_sec DESC
        `, [statId]);

        const [crashes] = await pool.execute(`
            SELECT 
                a.package_name,
                a.app_name,
                dac.crash_time,
                dac.reason
            FROM device_app_crashes dac
            JOIN applications a ON a.id = dac.application_id
            WHERE dac.device_stat_id = ?
            ORDER BY dac.crash_time DESC
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
});

app.get("/dashboard/licences", async (req, res) => {

    try {

        const [rows] = await pool.query(`
            SELECT
                id,
                device_token,
                imei,
                device_name,
                device_mac
            FROM devices
            ORDER BY device_name ASC
        `);

        res.json(rows);

    } catch (err) {

        logger.error("licences_fetch_error", {
            error: err.message
        });

        res.status(500).json({
            status: "error",
            message: "Failed to fetch licences"
        });

    }

});

app.get("/dashboard/report/devices", async (req, res) => {

    try {

        /* ---------- DEVICES ---------- */

        const [devices] = await pool.query(`
        SELECT
            d.id,
            d.device_name,
            d.device_token,
            d.imei,
            d.device_mac,
            d.online,
            d.last_seen,
            COALESCE(g.name,'No group') AS group_name
        FROM devices d
        LEFT JOIN groups g ON d.group_id = g.id
        ORDER BY d.device_name
    `);


        /* ---------- SUMMARY ---------- */

        const online = devices.filter(d => d.online).length;
        const offline = devices.length - online;


        /* ---------- LOAD EXTRA DATA ---------- */

        const appStats = {};
        const crashStats = {};
        const commandStats = {};
        const actionStats = {};
        const freqStats = {};
        const freqBatches = {};

        for (const d of devices) {

            /* latest stats batch */

            const [[latestStat]] = await pool.query(`
            SELECT id
            FROM device_stats
            WHERE device_id = ?
            ORDER BY collected_at DESC
            LIMIT 1
        `,[d.id]);

            if(latestStat){

                const [apps] = await pool.query(`
                SELECT
                    COALESCE(a.app_name,a.package_name) AS app_name,
                    s.cpu_time_sec,
                    s.battery_pct,
                    s.received_mb,
                    s.transmitted_mb
                FROM device_app_stats s
                JOIN applications a ON s.application_id = a.id
                WHERE s.device_stat_id = ?
                ORDER BY s.battery_pct DESC
                LIMIT 10
            `,[latestStat.id]);

                const [crashes] = await pool.query(`
                    SELECT
                        COALESCE(a.app_name,a.package_name) AS app_name,
                        c.crash_time,
                        c.reason
                    FROM device_app_crashes c
                             JOIN applications a ON c.application_id = a.id
                             JOIN device_stats ds ON c.device_stat_id = ds.id
                    WHERE ds.device_id = ?
                    ORDER BY c.created_at DESC
                        LIMIT 10
                `,[latestStat.id]);

                appStats[d.id] = apps;
                crashStats[d.id] = crashes;

            } else {

                appStats[d.id] = [];
                crashStats[d.id] = [];

            }

            /* commands */

            const [commands] = await pool.query(`
            SELECT command,status,created_at
            FROM commands
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 5
        `,[d.id]);

            commandStats[d.id] = commands;

            /* user actions */

            const [actions] = await pool.query(`
            SELECT action,created_at
            FROM device_user_actions
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 5
        `,[d.id]);

            actionStats[d.id] = actions;

            /* frequency analysis */

            const [freq] = await pool.query(`
            SELECT
                core_type,
                AVG(frequency_khz) avg_freq,
                MAX(frequency_khz) max_freq,
                COUNT(*) samples
            FROM cpu_frequency_segments
            WHERE device_id = ?
            GROUP BY core_type
        `,[d.id]);

            freqStats[d.id] = freq;

            /* processed batches */

            const [[batch]] = await pool.query(`
            SELECT
                COUNT(*) batches,
                SUM(segments_count) segments
            FROM processed_frequency_batches
            WHERE device_id = ?
        `,[d.id]);

            freqBatches[d.id] = batch;

        }


        /* ---------- CREATE PDF ---------- */

        const doc = new PDFDocument({margin:40});

        res.setHeader("Content-Type","application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=device_report_${Date.now()}.pdf`
        );

        doc.pipe(res);


        /* ---------- HEADER ---------- */

        doc.fontSize(22)
            .text("Device Efficiency Management Report",{align:"center"});

        doc.moveDown();

        doc.fontSize(10)
            .text(`Generated: ${new Date().toLocaleString()}`,{align:"center"});

        doc.moveDown(2);


        /* ---------- SYSTEM SUMMARY ---------- */

        doc.fontSize(16).text("System Summary");

        doc.moveDown();

        doc.fontSize(12);
        doc.text(`Total Devices: ${devices.length}`,40,doc.y);
        doc.text(`Online Devices: ${online}`,40,doc.y);
        doc.text(`Offline Devices: ${offline}`,40,doc.y);

        doc.moveDown(2);


        /* ---------- DEVICE SECTIONS ---------- */

        for(const device of devices){

            doc.fontSize(16).text(`Device: ${device.device_name}`);

            doc.moveDown(0.5);

            doc.fontSize(11);

            doc.text(`Licence Key: ${device.device_token}`,40,doc.y);
            doc.text(`IMEI: ${device.imei}`,40,doc.y);
            doc.text(`MAC: ${device.device_mac}`,40,doc.y);
            doc.text(`Group: ${device.group_name}`,40,doc.y);
            doc.text(`Status: ${device.online ? "ONLINE":"OFFLINE"}`,40,doc.y);
            doc.text(`Last Seen: ${device.last_seen || "-"}`,40,doc.y);

            doc.moveDown();


            /* ---------- CPU FREQUENCY ---------- */

            doc.fontSize(14).text("CPU Frequency Analysis");

            doc.moveDown(0.5);

            freqStats[device.id].forEach(f => {

                doc.fontSize(10).text(
                    `${f.core_type.toUpperCase()} cores
Avg ${(f.avg_freq/1000).toFixed(1)} MHz
Max ${(f.max_freq/1000).toFixed(1)} MHz
Samples ${f.samples}`,
                    40,
                    doc.y
                );

                doc.moveDown(0.5);

            });


            /* ---------- BATCH INFO ---------- */

            const batch = freqBatches[device.id];

            doc.fontSize(14).text("Frequency Processing");

            doc.moveDown(0.5);

            doc.fontSize(10)
                .text(`Batches processed: ${batch.batches || 0}`,40,doc.y);

            doc.text(`Segments analyzed: ${batch.segments || 0}`,40,doc.y);

            doc.moveDown();


            /* ---------- TOP APPS ---------- */

            doc.fontSize(14).text("Top Applications");

            doc.moveDown(0.5);

            const apps = appStats[device.id];

            if(apps.length === 0){

                doc.fontSize(10).text("No statistics available",40,doc.y);

            } else {

                apps.forEach(a => {

                    doc.fontSize(10).text(
                        `${a.app_name}
CPU ${a.cpu_time_sec.toFixed(2)}s
Battery ${(a.battery_pct).toFixed(2)}%
RX ${a.received_mb.toFixed(2)} MB
TX ${a.transmitted_mb.toFixed(2)} MB`,
                        40,
                        doc.y
                    );

                    doc.moveDown(0.5);

                });

            }

            doc.moveDown();


            /* ---------- CRASHES ---------- */

            doc.fontSize(14).text("Crash History");

            doc.moveDown(0.5);

            const crashes = crashStats[device.id];

            if(crashes.length === 0){

                doc.fontSize(10).text("No crashes recorded",40,doc.y);

            } else {

                crashes.forEach(c => {

                    doc.fontSize(10).text(
                        `${c.crash_time} - ${c.app_name} (${c.reason || "Unknown"})`,
                        40,
                        doc.y
                    );

                });

            }

            doc.moveDown();


            /* ---------- COMMANDS ---------- */

            doc.fontSize(14).text("Recent Commands");

            doc.moveDown(0.5);

            commandStats[device.id].forEach(cmd => {

                doc.fontSize(10).text(
                    `${cmd.created_at} - ${cmd.command} (${cmd.status})`,
                    40,
                    doc.y
                );

            });

            doc.moveDown();


            /* ---------- USER ACTIONS ---------- */

            doc.fontSize(14).text("Recent User Actions");

            doc.moveDown(0.5);

            actionStats[device.id].forEach(a => {

                doc.fontSize(10).text(
                    `${a.created_at} - ${a.action}`,
                    40,
                    doc.y
                );

            });

            doc.addPage();

        }

        doc.end();

    } catch(err){

        logger.error("device_report_error",{error:err.message});

        res.status(500).json({
            status:"error",
            message:"Failed to generate report"
        });

    }
});
// HELPER FUNCTION

async function sendCommand(deviceId, command, payload = null) {

    const active = activeDevices.get(deviceId);
    const [result] = await pool.execute(
        `INSERT INTO commands 
        (device_id, session_id, command, payload, status)
        VALUES (?, ?, ?, ?, 'pending')`,
        [
            deviceId,
            active?.sessionId ?? null,
            command,
            JSON.stringify(payload || null)
        ]
    );

    const commandId = result.insertId;
    broadcastToDashboard({
        type: 'command_created',
        deviceId,
        commandId,
        command
    });

    if (active) {
        active.ws.send(JSON.stringify({
            type: 'command',
            command_id: commandId,
            command: command,
            payload: payload
        }));
        await pool.execute(
            `UPDATE commands SET status='sent' WHERE id=?`,
            [commandId]
        );
        logger.info('command_sent', {
            deviceId,
            commandId,
            command
        });

    } else {
        logger.info('command_queued_offline', {
            deviceId,
            commandId,
            command
        });

    }

    return commandId;
}

function compressToSegments(startTs, intervalMs, freqArray) {
    const segments = [];
    if (!Array.isArray(freqArray) || freqArray.length === 0) {
        return segments;
    }

    let i = 0;
    const n = freqArray.length;
    while (i < n) {
        const freq = Number(freqArray[i]) || 0;
        let j = i + 1;
        while (j < n && Number(freqArray[j]) === freq) {
            j++;
        }
        const segStart = startTs + BigInt(i * intervalMs);
        const segEnd   = startTs + BigInt(j * intervalMs);
        segments.push({
            start: segStart,
            end: segEnd,
            freq: freq
        });
        i = j;
    }

    return segments;
}

async function processFrequencyBatch(deviceId, payload) {
    console.log(payload);

    const batchId = payload.batch_id;
    if (!batchId) {
        logger.warn('missing_batch_id', { deviceId });
        return;
    }

    try {
        const [existing] = await pool.execute(
            `SELECT 1
             FROM processed_frequency_batches
             WHERE device_id=? AND batch_id=?`,
            [deviceId, batchId]
        );
        if (existing.length > 0) {
            logger.info('duplicate_frequency_batch_skipped', {
                deviceId,
                batchId
            });
            return;
        }

        await pool.execute(
            `INSERT INTO processed_frequency_batches
             (batch_id, device_id, status)
             VALUES (?, ?, 'received')`,
            [batchId, deviceId]
        );


        const startTs = BigInt(payload.start_timestamp || 0);
        const endTs   = BigInt(payload.end_timestamp || 0);
        const intervalMs = Number(payload.interval || 250);

        if (startTs <= 0 || endTs <= startTs) {
            throw new Error('invalid timestamps');
        }

        const durationMs = Number(endTs - startTs);

        // const MIN_BATCH_DURATION = 0;
        // const MAX_BATCH_DURATION = 2 * 60 * 60 * 1000;
        //
        // if (durationMs < MIN_BATCH_DURATION || durationMs > MAX_BATCH_DURATION) {
        //     throw new Error(`invalid batch duration ${durationMs}`);
        // }

        const expectedSamples = Math.round(durationMs / intervalMs) + 1;

        // const MAX_SAMPLES = 20000;
        // if (expectedSamples > MAX_SAMPLES) {
        //     throw new Error(`too many samples ${expectedSamples}`);
        // }


        function normalizeFreqArray(freqArray, expected) {
            if (!Array.isArray(freqArray) || freqArray.length === 0) {
                logger.warn('empty_frequency_array', { deviceId, batchId });
                return new Array(expected).fill(0);
            }

            if (freqArray.length === 1) {

                const freq = Number(freqArray[0]) || 0;
                logger.info('constant_frequency_batch', {
                    deviceId,
                    batchId,
                    freq
                });
                return new Array(expected).fill(freq);
            }

            const normalized = freqArray.map(f => {
                const num = Number(f);
                return isNaN(num) ? 0 : Math.round(num);
            });

            if (normalized.length > expected) {
                logger.warn('frequency_array_trimmed', {
                    deviceId,
                    batchId,
                    expected,
                    received: normalized.length
                });
                return normalized.slice(0, expected);
            }

            if (normalized.length < expected) {
                const lastFreq = normalized[normalized.length - 1] || 0;
                logger.warn('frequency_array_extended', {
                    deviceId,
                    batchId,
                    expected,
                    received: normalized.length
                });
                while (normalized.length < expected) {
                    normalized.push(lastFreq);
                }
            }

            return normalized;
        }

        const smallFreq = normalizeFreqArray(
            payload.small_cores_frequency || [],
            expectedSamples
        );

        const bigFreq = normalizeFreqArray(
            payload.big_cores_frequency || [],
            expectedSamples
        );


        const smallSegments = compressToSegments(startTs, intervalMs, smallFreq);
        const bigSegments   = compressToSegments(startTs, intervalMs, bigFreq);
        const allRows = [
            ...smallSegments.map(s => [deviceId, 'small', s.start, s.end, s.freq, batchId]),
            ...bigSegments.map(s => [deviceId, 'big', s.start, s.end, s.freq, batchId])
        ];
        if (allRows.length === 0) {
            await markBatchProcessed(batchId, 0);
            logger.warn('empty_frequency_segments', {
                deviceId,
                batchId
            });
            return;
        }


        await pool.query(
            `INSERT IGNORE INTO cpu_frequency_segments
             (device_id, core_type, segment_start, segment_end, frequency_khz, batch_id)
             VALUES ?`,
            [allRows]
        );
        await markBatchProcessed(deviceId, batchId, allRows.length);
        logger.info('frequency_batch_processed', {
            deviceId,
            batchId,
            durationSeconds: durationMs / 1000,
            expectedSamples,
            smallSegments: smallSegments.length,
            bigSegments: bigSegments.length,
            totalSegments: allRows.length
        });
    } catch (err) {
        logger.error('processFrequencyBatch_failed', {
            deviceId,
            batchId,
            error: err.message
        });
        await markBatchFailed(batchId, err.message.substring(0,255))
            .catch(() => {});
    }
}

async function processStatsPayload(deviceId, payload) {

    const { boot_time, apps = [], crashes = [], fixed = null } = payload;

    if (!boot_time) {
        logger.warn('stats_missing_boot_time', { deviceId });
        return;
    }

    try {
        const [statResult] = await pool.execute(
            `INSERT INTO device_stats (device_id, boot_time, fixed)
             VALUES (?, ?, ?)`,
            [deviceId, boot_time, fixed]
        );

        const deviceStatId = statResult.insertId;
        const packages = new Set();
        for (const app of apps) {
            if (app.package) packages.add(app.package);
        }
        for (const crash of crashes) {
            if (crash.package) packages.add(crash.package);
        }


        const packageList = Array.from(packages);
        let appMap = new Map();
        if (packageList.length > 0) {
            const placeholders = packageList.map(() => '?').join(',');
            const [rows] = await pool.execute(
                `SELECT id, package_name
                 FROM applications
                 WHERE package_name IN (${placeholders})`,
                packageList
            );
            for (const row of rows) {
                appMap.set(row.package_name, row.id);
            }
        }



        for (const pkg of packageList) {
            if (!appMap.has(pkg)) {
                const [insertRes] = await pool.execute(
                    `INSERT INTO applications (package_name, app_name)
                     VALUES (?, ?)`,
                    [pkg, pkg]
                );
                appMap.set(pkg, insertRes.insertId);
                logger.info('new_application_from_stats', {
                    package: pkg,
                    applicationId: insertRes.insertId
                });
            }
        }


        const appStatsRows = [];
        for (const app of apps) {
            const applicationId = appMap.get(app.package);
            if (!applicationId) continue;
            appStatsRows.push([
                deviceStatId,
                applicationId,
                Number(app.cpu_time || 0),
                Number(app.battery_pct || 0),
                Number(app.received_mb || 0),
                Number(app.transmitted_mb || 0)
            ]);
        }

        if (appStatsRows.length > 0) {
            await pool.query(
                `INSERT INTO device_app_stats
                 (device_stat_id, application_id, cpu_time_sec, battery_pct, received_mb, transmitted_mb)
                 VALUES ?`,
                [appStatsRows]
            );
        }

        const crashRows = [];
        for (const crash of crashes) {
            if (!crash.time || !crash.package) continue;
            const applicationId = appMap.get(crash.package);
            if (!applicationId) continue;
            const crashTime = parseAndroidCrashTime(crash.time);

            crashRows.push([
                deviceStatId,
                applicationId,
                crashTime,
                crash.reason || null
            ]);
        }

        if (crashRows.length > 0) {
            await pool.query(
                `INSERT INTO device_app_crashes
                 (device_stat_id, application_id, crash_time, reason)
                 VALUES ?`,
                [crashRows]
            );
        }

        logger.info('stats_processed_successfully', {
            deviceId,
            boot_time,
            appsCount: apps.length,
            crashesCount: crashes.length,
            deviceStatId
        });
    } catch (err) {

        logger.error('processStatsPayload_failed', {
            deviceId,
            error: err.message,
            stack: err.stack?.substring(0, 300)
        });
    }
}

async function broadcastDeviceStats(deviceId){

    const [stats] = await pool.execute(`
        SELECT id, boot_time, collected_at
        FROM device_stats
        WHERE device_id = ?
        ORDER BY collected_at DESC
        LIMIT 1
    `,[deviceId]);

    if(!stats.length) return;

    const statId = stats[0].id;

    const [apps] = await pool.execute(`
        SELECT 
            a.package_name,
            a.app_name,
            das.cpu_time_sec,
            das.battery_pct,
            das.received_mb,
            das.transmitted_mb
        FROM device_app_stats das
        JOIN applications a ON a.id = das.application_id
        WHERE das.device_stat_id = ?
        ORDER BY das.cpu_time_sec DESC
    `,[statId]);

    const [crashes] = await pool.execute(`
        SELECT 
            a.package_name,
            a.app_name,
            dac.crash_time,
            dac.reason
        FROM device_app_crashes dac
        JOIN applications a ON a.id = dac.application_id
        WHERE dac.device_stat_id = ?
        ORDER BY dac.crash_time DESC
    `,[statId]);

    broadcastToDashboard({
        type: "device_stats",
        deviceId: deviceId,
        apps: apps,
        crashes: crashes,
        collected_at: stats[0].collected_at
    });

}

function broadcastToDashboard(data) {
    const msg = JSON.stringify(data);
    for (const client of dashboardClients) {
        if (client.readyState === 1) {
            client.send(msg);
        }
    }
}

async function markBatchProcessed(deviceId, batchId, segmentsCount) {

    await pool.execute(
        `UPDATE processed_frequency_batches
         SET status='processed',
             processed_at=CURRENT_TIMESTAMP(3),
             segments_count=?
         WHERE device_id=? AND batch_id=?`,
        [segmentsCount, deviceId, batchId]
    );
}

async function markBatchFailed(deviceId, batchId, errorMessage) {

    await pool.execute(
        `UPDATE processed_frequency_batches
         SET status='failed', processed_at=CURRENT_TIMESTAMP(3), segments_count=? 
        WHERE device_id=? AND batch_id=?`,
        [errorMessage, deviceId, batchId]
    );
}

async function handleDeviceDisconnect(ws, reason = "connection_lost") {
    if (!ws.deviceId) return;
    const active = activeDevices.get(ws.deviceId);

    if (active && active.sessionId === ws.sessionId) {
        activeDevices.delete(ws.deviceId);
        await pool.execute(
            `UPDATE devices SET online=0 WHERE id=?`,
            [ws.deviceId]
        );
        broadcastToDashboard({
            type: 'device_offline',
            deviceId: ws.deviceId,
            sessionId: ws.sessionId,
            timestamp: new Date().toISOString(),
            reason
        });
        logger.info('device_disconnected', {
            deviceId: ws.deviceId,
            reason
        });
    }
}

function parseAndroidCrashTime(timeStr){
    const year = new Date().getFullYear();
    const [datePart,timePart] = timeStr.split(" ");
    const [month,day] = datePart.split("-");
    const cleanTime = timePart.split(".")[0]; // remove milliseconds
    return `${year}-${month}-${day} ${cleanTime}`;
}

// WEBSOCKET HANDLING

wss.on('connection', (ws, req) => {

    const isDashboard = req.url === '/dashboard';
    if (isDashboard) {
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

                    broadcastToDashboard({
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
                    broadcastToDashboard({
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
                    broadcastToDashboard({
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

                broadcastToDashboard({
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

                processStatsPayload(ws.deviceId, data)
                    .then(()=> broadcastDeviceStats(ws.deviceId))
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

                        broadcastToDashboard({
                            type: 'device_logout',
                            deviceId: ws.deviceId,
                            sessionId: ws.sessionId,
                            timestamp: new Date().toISOString(),
                            reason: "logout"
                        });

                        logger.info('device_user_logout', {
                            deviceId: ws.deviceId,
                            sessionId: ws.sessionId
                        });

                        ws.terminate();
                        return;
                    }

                    broadcastToDashboard({
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
        try {
            await handleDeviceDisconnect(ws, "socket_closed");
        } catch (err) {
            logger.error('disconnect_handler_failed', {
                error: err.message
            });
        }

    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.deviceId) return;
        if (ws.missedPongs >= MAX_MISSED_PONGS) {
            handleDeviceDisconnect(ws, "ping_timeout");
            return ws.terminate();
        }
        ws.missedPongs++;
        ws.ping();
    });
}, PING_INTERVAL);


server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on https://109.72.48.188:3000');
    console.log('Server running on https://127.0.0.1:3000');
});