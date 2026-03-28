const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const pool = require('../config/db');
const { buildFrequencyAnalytics, formatDuration } = require('./frequencyAnalyticsService');

const REPORT_COLORS = {
    background: '#0b1731',
    surface: '#12284f',
    surfaceAlt: '#1b335f',
    accent: '#3e5ea7',
    text: '#eef4ff',
    muted: '#b9c9ef'
};
const LOGO_PATH = path.resolve(__dirname, '../../docs/assets/freq-logo.jfif');

async function generateDeviceReport(res, options = {}) {
    const selectedDeviceIds = normalizeDeviceIds(options.deviceIds);
    const devices = await loadDevices(selectedDeviceIds);

    if (!devices.length) {
        res.status(404).json({ error: 'No devices found for the requested report' });
        return;
    }

    const deviceIds = devices.map((device) => device.id);
    const frequencySegmentsByDevice = await loadFrequencySegments(deviceIds);
    const crashesByDevice = await loadCrashes(deviceIds);

    const doc = new PDFDocument({
        margin: 42,
        autoFirstPage: true
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename=device_report_${Date.now()}.pdf`
    );
    doc.pipe(res);

    devices.forEach((device, index) => {
        if (index > 0) {
            doc.addPage();
        }

        renderDevicePage(doc, device, {
            frequencySegments: frequencySegmentsByDevice.get(device.id) || [],
            crashes: crashesByDevice.get(device.id) || []
        });
    });

    doc.end();
}

function renderDevicePage(doc, device, details) {
    const analytics = buildFrequencyAnalytics(details.frequencySegments, details.crashes);

    renderPageBackground(doc);
    renderLogo(doc);
    doc.fontSize(20).text(device.device_name || `Device ${device.id}`, { align: 'left' });
    doc.moveDown(0.35);
    doc.fillColor(REPORT_COLORS.text);
    doc.fontSize(10);
    doc.text(`Device ID: ${device.id}`);
    doc.text(`IMEI: ${device.imei || '-'}`);
    doc.text(`Group: ${device.group_name || 'No group'}`);
    doc.text(`Status: ${device.online ? 'ONLINE' : 'OFFLINE'}`);
    doc.text(`Last Seen: ${formatDateTime(device.last_seen)}`);
    doc.moveDown(1);

    renderSectionTitle(doc, 'Frequency Summary');
    doc.moveDown(0.35);
    renderSummaryGrid(doc, analytics.summary);
    doc.moveDown(1.1);

    renderSectionTitle(doc, 'Fixed Frequency Sessions');
    doc.moveDown(0.35);

    if (!analytics.fixedSessions.length) {
        doc.fontSize(10).fillColor(REPORT_COLORS.muted).text('No fixed frequency sessions detected.');
        doc.fillColor(REPORT_COLORS.text);
    } else {
        renderFrequencyTable(doc, analytics.fixedSessions);
    }

    doc.moveDown(1.1);
    renderSectionTitle(doc, 'Application Crashes');
    doc.moveDown(0.35);

    if (!details.crashes.length) {
        doc.fontSize(10).fillColor(REPORT_COLORS.muted).text('No crashes recorded.');
        doc.fillColor(REPORT_COLORS.text);
    } else {
        renderCrashesTable(doc, details.crashes);
    }
}

function renderFrequencyTable(doc, segments) {
    const visibleSegments = segments.slice(0, 20);
    renderTableHeader(doc, ['Start', 'End', 'Duration', 'Small', 'Big']);

    visibleSegments.forEach((segment) => {
        renderTableRow(doc, [
            formatDateTime(segment.start_timestamp),
            formatDateTime(segment.end_timestamp),
            formatDuration(segment.duration_ms),
            formatFrequency(segment.small_frequency_khz),
            formatFrequency(segment.big_frequency_khz)
        ]);
    });

    if (segments.length > visibleSegments.length) {
        doc.moveDown(0.25);
        doc.fontSize(9).fillColor(REPORT_COLORS.muted).text(
            `Showing ${visibleSegments.length} of ${segments.length} total frequency segments.`
        );
        doc.fillColor(REPORT_COLORS.text);
    }
}

function renderSummaryGrid(doc, summary) {
    const rows = [
        ['Observed Time', formatDuration(summary.total_observed_ms), 'Fixed Time', formatDuration(summary.fixed_time_ms)],
        ['Fixed %', `${summary.fixed_percent || 0}%`, 'Fixed Sessions', String(summary.fixed_session_count || 0)],
        ['Crashes During Fixed', String(summary.crashes_during_fixed || 0), 'Crashes Outside Fixed', String(summary.crashes_outside_fixed || 0)],
        ['Top Small Fixed', formatFrequency(summary.top_small_fixed_freq_khz), 'Top Big Fixed', formatFrequency(summary.top_big_fixed_freq_khz)]
    ];

    rows.forEach((row) => {
        renderTableRow(doc, row);
    });
}

function renderCrashesTable(doc, crashes) {
    const visibleCrashes = crashes.slice(0, 20);
    renderTableHeader(doc, ['Timestamp', 'App', 'Reason']);

    visibleCrashes.forEach((crash) => {
        renderTableRow(doc, [
            formatDateTime(crash.crash_time),
            crash.app_name || crash.package_name || 'Unknown',
            truncateText(crash.reason || 'Unknown', 72)
        ]);
    });

    if (crashes.length > visibleCrashes.length) {
        doc.moveDown(0.25);
        doc.fontSize(9).fillColor(REPORT_COLORS.muted).text(
            `Showing ${visibleCrashes.length} of ${crashes.length} total crash events.`
        );
        doc.fillColor(REPORT_COLORS.text);
    }
}

function renderTableHeader(doc, columns) {
    doc.fontSize(10).fillColor(REPORT_COLORS.text);
    const top = doc.y;
    doc.roundedRect(42, top - 2, 510, 20, 6).fill(REPORT_COLORS.surfaceAlt);
    doc.fillColor(REPORT_COLORS.text);

    let x = 48;
    columns.forEach((column, index) => {
        doc.text(column, x, top + 3, {
            width: getColumnWidth(columns.length, index),
            ellipsis: true
        });
        x += getColumnWidth(columns.length, index);
    });

    doc.moveDown(1.4);
    doc.fillColor(REPORT_COLORS.text);
}

function renderTableRow(doc, columns) {
    const rowTop = doc.y;
    let x = 48;

    columns.forEach((column, index) => {
        doc.fontSize(9).fillColor(REPORT_COLORS.text).text(String(column), x, rowTop, {
            width: getColumnWidth(columns.length, index),
            ellipsis: true
        });
        x += getColumnWidth(columns.length, index);
    });

    doc.moveDown(1.2);
}

function getColumnWidth(columnCount, index) {
    if (columnCount === 5) {
        return [55, 120, 120, 85, 110][index];
    }

    if (columnCount === 4) {
        return [125, 120, 125, 120][index];
    }

    if (columnCount === 3) {
        return [120, 130, 260][index];
    }

    return 150;
}

async function loadDevices(deviceIds) {
    const whereClause = deviceIds.length
        ? `WHERE d.id IN (${deviceIds.map(() => '?').join(', ')})`
        : '';

    const [rows] = await pool.execute(
        `
            SELECT
                d.id,
                d.device_name,
                d.imei,
                d.online,
                d.last_seen,
                COALESCE(g.name, 'No group') AS group_name
            FROM devices d
            LEFT JOIN groups g ON g.id = d.group_id
            ${whereClause}
            ORDER BY d.device_name ASC, d.id ASC
        `,
        deviceIds
    );

    return rows;
}

async function loadFrequencySegments(deviceIds) {
    if (!deviceIds.length) {
        return new Map();
    }

    const [rows] = await pool.query(
        `
            SELECT
                device_id,
                core_type,
                segment_start,
                segment_end,
                duration_ms,
                frequency_khz
            FROM cpu_frequency_segments
            WHERE device_id IN (${deviceIds.map(() => '?').join(', ')})
            ORDER BY device_id ASC, segment_start DESC
        `,
        deviceIds
    );

    return groupRowsByDevice(rows);
}

async function loadCrashes(deviceIds) {
    if (!deviceIds.length) {
        return new Map();
    }

    const [rows] = await pool.query(
        `
            SELECT
                ds.device_id,
                dac.crash_time,
                dac.reason,
                a.package_name,
                a.app_name
            FROM device_app_crashes dac
            INNER JOIN device_stats ds ON ds.id = dac.device_stat_id
            INNER JOIN applications a ON a.id = dac.application_id
            WHERE ds.device_id IN (${deviceIds.map(() => '?').join(', ')})
            ORDER BY ds.device_id ASC, dac.crash_time DESC
        `,
        deviceIds
    );

    return groupRowsByDevice(rows);
}

function groupRowsByDevice(rows) {
    const grouped = new Map();

    rows.forEach((row) => {
        if (!grouped.has(row.device_id)) {
            grouped.set(row.device_id, []);
        }

        grouped.get(row.device_id).push(row);
    });

    return grouped;
}

function normalizeDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds)) {
        return [];
    }

    return [...new Set(
        deviceIds
            .map((value) => parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value > 0)
    )];
}

function formatDateTime(value) {
    if (!value) {
        return '-';
    }

    return new Date(value).toLocaleString();
}

function formatFrequency(value) {
    if (!Number.isFinite(Number(value))) {
        return '-';
    }

    return `${(Number(value) / 1000).toFixed(1)} MHz`;
}

function renderPageBackground(doc) {
    doc.save();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(REPORT_COLORS.background);
    doc.restore();
    doc.fillColor(REPORT_COLORS.text);
}

function renderLogo(doc) {
    if (!fs.existsSync(LOGO_PATH)) {
        return;
    }

    doc.image(LOGO_PATH, 42, 32, {
        width: 42,
        height: 42
    });
    doc.y = Math.max(doc.y, 84);
}

function renderSectionTitle(doc, title) {
    const y = doc.y;
    doc.roundedRect(42, y - 2, 510, 22, 6).fill(REPORT_COLORS.surface);
    doc.fillColor(REPORT_COLORS.text);
    doc.fontSize(14).text(title, 54, y + 3);
    doc.moveDown(1.2);
}

function truncateText(value, maxLength) {
    const stringValue = String(value || '');
    if (stringValue.length <= maxLength) {
        return stringValue;
    }

    return `${stringValue.slice(0, maxLength - 1)}...`;
}

module.exports = {
    generateDeviceReport
};
