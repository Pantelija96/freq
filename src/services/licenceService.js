const crypto = require('crypto');

const pool = require('../config/db');

function buildLicenceKey(deviceId, imei) {
    return crypto
        .createHash('sha256')
        .update(`${deviceId}:${imei}`)
        .digest('hex');
}

async function syncLicenceKeys() {
    const [devices] = await pool.execute(`
        SELECT id, imei
        FROM devices
        WHERE imei IS NOT NULL AND imei <> ''
    `);

    for (const device of devices) {
        const licenceKey = buildLicenceKey(device.id, device.imei);
        await pool.execute(
            `INSERT INTO licences (device_id, licence_key)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE licence_key = VALUES(licence_key)`,
            [device.id, licenceKey]
        );
    }
}

async function listLicences() {
    await syncLicenceKeys();

    const [rows] = await pool.execute(`
        SELECT
            l.id,
            l.licence_key,
            l.created_at,
            l.updated_at,
            d.id AS device_id,
            d.imei,
            d.device_name,
            d.device_mac
        FROM licences l
        INNER JOIN devices d ON d.id = l.device_id
        ORDER BY d.device_name ASC, d.id ASC
    `);

    return rows;
}

module.exports = {
    buildLicenceKey,
    syncLicenceKeys,
    listLicences
};
