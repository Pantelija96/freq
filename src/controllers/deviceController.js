// src/controllers/deviceController.js

const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../utils/logger');

const provisionDevice = async (req, res) => {
    const { imei, group, app_list, device_name, device_mac } = req.body;

    const appsCount = app_list && typeof app_list === 'object' 
        ? Object.keys(app_list).length 
        : 0;

    logger.info('device_provision_request', {
        imei,
        group,
        device_name,
        device_mac,
        appsCount,
        ip: req.ip
    });

    if (!imei || !group || !app_list || !device_name) {
        logger.warn('device_provision_invalid_payload', { imei, group, device_name, device_mac, appsCount, ip: req.ip });
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const deviceToken = crypto.randomBytes(32).toString('hex');

        // Create or get group
        await connection.execute(
            `INSERT INTO groups (name) VALUES (?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            [group]
        );

        const [groupRows] = await connection.execute(
            `SELECT id FROM groups WHERE name = ?`, [group]
        );
        const groupId = groupRows[0].id;

        // Check if device exists
        const [deviceRows] = await connection.execute(
            `SELECT id, device_token FROM devices WHERE imei = ?`, [imei]
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
                `UPDATE devices SET device_name = ?, group_id = ? WHERE id = ?`,
                [device_name || null, groupId, deviceId]
            );
        }

        // Clear old apps and insert new ones
        await connection.execute(`DELETE FROM device_apps WHERE device_id = ?`, [deviceId]);

        const packages = Object.keys(app_list);
        for (const pkg of packages) {
            const name = app_list[pkg];

            await connection.execute(
                `INSERT INTO applications (package_name, app_name)
                 VALUES (?, ?) ON DUPLICATE KEY UPDATE app_name = VALUES(app_name)`,
                [pkg, name]
            );

            const [appRows] = await connection.execute(
                `SELECT id FROM applications WHERE package_name = ?`, [pkg]
            );

            const appId = appRows[0].id;

            await connection.execute(
                `INSERT INTO device_apps (device_id, application_id) VALUES (?, ?)`,
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
};

const loginDevice = async (req, res) => {
    const { imei, device_token } = req.body;

    logger.info('device_login_attempt', { imei, ip: req.ip });

    if (!imei || !device_token) {
        logger.warn('device_login_invalid_payload', { imei, ip: req.ip });
        return res.status(400).json({ status: 'error', error: 'Missing credentials' });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT id, device_name FROM devices WHERE imei = ? AND device_token = ? LIMIT 1`,
            [imei, device_token]
        );

        if (!rows.length) {
            logger.warn('device_login_failed', { imei, ip: req.ip, reason: 'invalid_credentials' });
            return res.status(401).json({ status: 'error', error: 'Invalid credentials' });
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
            wss_url: config.wssUrl   // ← We will fix config import in next step if needed
        });

    } catch (err) {
        logger.error('device_login_error', {
            imei,
            ip: req.ip,
            error: err.message
        });
        res.status(500).json({ status: 'error', error: 'Server error' });
    }
};

module.exports = {
    provisionDevice,
    loginDevice
};
