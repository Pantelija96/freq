const PDFDocument = require("pdfkit");
const pool = require('../config/db');

const generateDeviceReport = async (res) => {
    try {
        const [devices] = await pool.query(`
            SELECT d.id, d.device_name, d.device_token, d.imei, d.device_mac, 
                   d.online, d.last_seen, COALESCE(g.name,'No group') AS group_name
            FROM devices d
            LEFT JOIN groups g ON d.group_id = g.id
            ORDER BY d.device_name
        `);

        const online = devices.filter(d => d.online).length;
        const offline = devices.length - online;

        const appStats = {};
        const crashStats = {};
        const commandStats = {};
        const actionStats = {};
        const freqStats = {};
        const freqBatches = {};

        for (const d of devices) {
            const [[latestStat]] = await pool.query(`
                SELECT id FROM device_stats WHERE device_id = ? ORDER BY collected_at DESC LIMIT 1
            `, [d.id]);

            if (latestStat) {
                const [apps] = await pool.query(`
                    SELECT COALESCE(a.app_name,a.package_name) AS app_name, s.cpu_time_sec, 
                           s.battery_pct, s.received_mb, s.transmitted_mb
                    FROM device_app_stats s
                    JOIN applications a ON s.application_id = a.id
                    WHERE s.device_stat_id = ?
                    ORDER BY s.battery_pct DESC LIMIT 10
                `, [latestStat.id]);

                const [crashes] = await pool.query(`
                    SELECT COALESCE(a.app_name,a.package_name) AS app_name, c.crash_time, c.reason
                    FROM device_app_crashes c
                    JOIN applications a ON c.application_id = a.id
                    WHERE c.device_stat_id = ?
                    ORDER BY c.created_at DESC LIMIT 10
                `, [latestStat.id]);

                appStats[d.id] = apps;
                crashStats[d.id] = crashes;
            } else {
                appStats[d.id] = [];
                crashStats[d.id] = [];
            }

            const [commands] = await pool.query(`
                SELECT command, status, created_at FROM commands 
                WHERE device_id = ? ORDER BY created_at DESC LIMIT 5
            `, [d.id]);
            commandStats[d.id] = commands;

            const [actions] = await pool.query(`
                SELECT action, created_at FROM device_user_actions 
                WHERE device_id = ? ORDER BY created_at DESC LIMIT 5
            `, [d.id]);
            actionStats[d.id] = actions;

            const [freq] = await pool.query(`
                SELECT core_type, AVG(frequency_khz) avg_freq, MAX(frequency_khz) max_freq, COUNT(*) samples
                FROM cpu_frequency_segments WHERE device_id = ? GROUP BY core_type
            `, [d.id]);
            freqStats[d.id] = freq;

            const [[batch]] = await pool.query(`
                SELECT COUNT(*) batches, SUM(segments_count) segments
                FROM processed_frequency_batches WHERE device_id = ?
            `, [d.id]);
            freqBatches[d.id] = batch;
        }

        const doc = new PDFDocument({ margin: 40 });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=device_report_${Date.now()}.pdf`);
        doc.pipe(res);

        doc.fontSize(22).text("Device Efficiency Management Report", { align: "center" });
        doc.moveDown();
        doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
        doc.moveDown(2);

        doc.fontSize(16).text("System Summary");
        doc.moveDown();
        doc.fontSize(12);
        doc.text(`Total Devices: ${devices.length}`, 40, doc.y);
        doc.text(`Online Devices: ${online}`, 40, doc.y);
        doc.text(`Offline Devices: ${offline}`, 40, doc.y);
        doc.moveDown(2);

        for (const device of devices) {
            doc.fontSize(16).text(`Device: ${device.device_name}`);
            doc.moveDown(0.5);
            doc.fontSize(11);
            doc.text(`Licence Key: ${device.device_token}`, 40, doc.y);
            doc.text(`IMEI: ${device.imei}`, 40, doc.y);
            doc.text(`MAC: ${device.device_mac}`, 40, doc.y);
            doc.text(`Group: ${device.group_name}`, 40, doc.y);
            doc.text(`Status: ${device.online ? "ONLINE" : "OFFLINE"}`, 40, doc.y);
            doc.text(`Last Seen: ${device.last_seen || "-"}`, 40, doc.y);
            doc.moveDown();

            // CPU Frequency
            doc.fontSize(14).text("CPU Frequency Analysis");
            doc.moveDown(0.5);
            freqStats[device.id].forEach(f => {
                doc.fontSize(10).text(
                    `${f.core_type.toUpperCase()} cores\nAvg ${(f.avg_freq/1000).toFixed(1)} MHz\nMax ${(f.max_freq/1000).toFixed(1)} MHz\nSamples ${f.samples}`,
                    40, doc.y
                );
                doc.moveDown(0.5);
            });

            // Batch info
            const batch = freqBatches[device.id];
            doc.fontSize(14).text("Frequency Processing");
            doc.moveDown(0.5);
            doc.fontSize(10).text(`Batches processed: ${batch.batches || 0}`, 40, doc.y);
            doc.text(`Segments analyzed: ${batch.segments || 0}`, 40, doc.y);
            doc.moveDown();

            // Top Apps
            doc.fontSize(14).text("Top Applications");
            doc.moveDown(0.5);
            const apps = appStats[device.id];
            if (apps.length === 0) {
                doc.fontSize(10).text("No statistics available", 40, doc.y);
            } else {
                apps.forEach(a => {
                    doc.fontSize(10).text(
                        `${a.app_name}\nCPU ${a.cpu_time_sec.toFixed(2)}s\nBattery ${(a.battery_pct).toFixed(2)}%\nRX ${a.received_mb.toFixed(2)} MB\nTX ${a.transmitted_mb.toFixed(2)} MB`,
                        40, doc.y
                    );
                    doc.moveDown(0.5);
                });
            }
            doc.moveDown();

            // Crashes
            doc.fontSize(14).text("Crash History");
            doc.moveDown(0.5);
            const crashes = crashStats[device.id];
            if (crashes.length === 0) {
                doc.fontSize(10).text("No crashes recorded", 40, doc.y);
            } else {
                crashes.forEach(c => {
                    doc.fontSize(10).text(`${c.crash_time} - ${c.app_name} (${c.reason || "Unknown"})`, 40, doc.y);
                });
            }
            doc.moveDown();

            // Commands
            doc.fontSize(14).text("Recent Commands");
            doc.moveDown(0.5);
            commandStats[device.id].forEach(cmd => {
                doc.fontSize(10).text(`${cmd.created_at} - ${cmd.command} (${cmd.status})`, 40, doc.y);
            });
            doc.moveDown();

            // User Actions
            doc.fontSize(14).text("Recent User Actions");
            doc.moveDown(0.5);
            actionStats[device.id].forEach(a => {
                doc.fontSize(10).text(`${a.created_at} - ${a.action}`, 40, doc.y);
            });

            doc.addPage();
        }

        doc.end();

    } catch (err) {
        console.error(err);
        if (!res.headersSent) {
            res.status(500).json({ status: "error", message: "Failed to generate report" });
        }
    }
};

module.exports = { generateDeviceReport };
