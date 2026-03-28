const logger = require('../utils/logger');
const { loginUser, issueAuthToken, normalizeUsername } = require('../services/userAuthService');

async function login(req, res) {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const user = await loginUser(username, password);
        if (!user) {
            logger.warn('dashboard_login_failed', { username, ip: req.ip, reason: 'invalid_credentials' });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = issueAuthToken(user);

        logger.info('dashboard_login_success', {
            userId: user.id,
            username: user.username,
            ip: req.ip
        });

        return res.json({
            status: 'ok',
            token,
            user
        });
    } catch (err) {
        logger.error('dashboard_login_error', {
            username,
            ip: req.ip,
            error: err.message
        });
        return res.status(500).json({ error: 'Login failed' });
    }
}

async function me(req, res) {
    return res.json({
        status: 'ok',
        auth_type: req.auth?.authType || 'unknown',
        user: req.auth?.user || null
    });
}

async function logout(req, res) {
    logger.info('dashboard_logout', {
        authType: req.auth?.authType || 'unknown',
        username: req.auth?.user?.username || null,
        ip: req.ip
    });

    return res.json({
        status: 'ok',
        message: 'Logged out. Remove the token client-side.',
        auth_type: req.auth?.authType || 'unknown'
    });
}

module.exports = {
    login,
    me,
    logout
};
