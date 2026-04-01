const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const pool = require('../config/db');
const config = require('../config');

async function loginUser(username, password) {
    const mode = config.auth.mode;

    if (mode !== 'local') {
        throw new Error(`Unsupported auth mode "${mode}". LDAP/AD integration is not implemented yet.`);
    }

    const normalizedUsername = normalizeUsername(username);
    const [rows] = await pool.execute(
        `SELECT id, username, password, role, first_name, last_name
         FROM users
         WHERE username = ?
         LIMIT 1`,
        [normalizedUsername]
    );

    if (!rows.length) {
        return null;
    }

    const user = rows[0];
    const validPassword = await verifyStoredPassword(password, user.password);
    if (!validPassword) {
        return null;
    }

    await pool.execute(
        `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`,
        [user.id]
    );

    return {
        id: user.id,
        username: user.username,
        role: user.role || 'user',
        first_name: user.first_name,
        last_name: user.last_name
    };
}

function issueAuthToken(user) {
    if (!config.auth.dashboardSecret) {
        throw new Error('DASHBOARD_SECRET must be configured before issuing auth tokens');
    }

    return jwt.sign(
        {
            id: user.id,
            sub: user.id,
            username: user.username,
            role: user.role,
            first_name: user.first_name,
            last_name: user.last_name,
        },
        config.auth.dashboardSecret,
        {
            expiresIn: config.auth.jwtExpiresIn
        }
    );
}

async function verifyStoredPassword(plainTextPassword, storedValue) {
    if (!storedValue || typeof storedValue !== 'string') {
        return false;
    }

    if (storedValue.startsWith('scrypt$')) {
        return verifyScryptPassword(plainTextPassword, storedValue);
    }

    return safeStringEqual(storedValue, String(plainTextPassword));
}

function verifyScryptPassword(plainTextPassword, storedValue) {
    const [, salt, hash] = storedValue.split('$');
    if (!salt || !hash) {
        return false;
    }

    const derivedKey = crypto.scryptSync(String(plainTextPassword), salt, 64).toString('hex');
    return safeHexEqual(hash, derivedKey);
}

function hashPassword(plainTextPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plainTextPassword), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function safeStringEqual(left, right) {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safeHexEqual(left, right) {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
    loginUser,
    issueAuthToken,
    hashPassword,
    normalizeUsername
};
