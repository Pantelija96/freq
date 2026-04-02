const logger = require('../utils/logger');
const {
    loginUser,
    changeUserPassword,
    issueAuthToken,
    normalizeUsername
} = require('../services/userAuthService');

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

async function changePassword(req, res) {
    const userId = Number(req.auth?.user?.id || req.auth?.user?.sub);
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Current password, new password, and confirmation are required' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    try {
        const result = await changeUserPassword(userId, currentPassword, newPassword);

        if (!result.ok) {
            if (result.reason === 'invalid_current_password') {
                return res.status(400).json({ error: 'Current password is incorrect' });
            }

            if (result.reason === 'user_not_found') {
                return res.status(404).json({ error: 'User not found' });
            }

            return res.status(400).json({ error: 'Password change failed' });
        }

        logger.info('dashboard_password_changed', {
            userId,
            username: req.auth?.user?.username || null,
            ip: req.ip
        });

        return res.json({
            status: 'ok',
            message: 'Password updated successfully'
        });
    } catch (err) {
        logger.error('dashboard_change_password_error', {
            userId,
            ip: req.ip,
            error: err.message
        });
        return res.status(500).json({ error: 'Failed to change password' });
    }
}

module.exports = {
    login,
    me,
    logout,
    changePassword
};
