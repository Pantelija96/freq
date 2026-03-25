const jwt = require('jsonwebtoken');

const config = require('../config');
const logger = require('../utils/logger');

function parseAuthorizationHeader(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') {
        return '';
    }

    const [scheme, ...rest] = headerValue.trim().split(/\s+/);
    if (scheme?.toLowerCase() === 'bearer' && rest.length > 0) {
        return rest.join(' ');
    }

    return headerValue.trim();
}

function extractToken(req, options = {}) {
    const headerNames = options.headerNames || [];

    const authorizationToken = parseAuthorizationHeader(req.headers?.authorization);
    if (authorizationToken) {
        return authorizationToken;
    }

    for (const headerName of headerNames) {
        const headerValue = req.headers?.[headerName];
        if (typeof headerValue === 'string' && headerValue.trim()) {
            return headerValue.trim();
        }
    }

    if (req.query?.token && typeof req.query.token === 'string') {
        return req.query.token.trim();
    }

    try {
        const requestUrl = new URL(req.url || '/', 'https://localhost');
        const queryToken = requestUrl.searchParams.get('token');
        if (queryToken) {
            return queryToken.trim();
        }
    } catch (err) {
        logger.warn('auth_token_url_parse_failed', { error: err.message });
    }

    return '';
}

function isAuthorized(token, secret) {
    if (!token || !secret) {
        return false;
    }

    if (token === secret) {
        return true;
    }

    try {
        jwt.verify(token, secret);
        return true;
    } catch {
        return false;
    }
}

function respondMissingSecret(res, eventName) {
    logger.error(eventName, { configured: false });
    return res.status(503).json({ error: 'Authentication is not configured' });
}

function requireDashboardAuth(req, res, next) {
    const secret = config.auth.dashboardSecret;
    if (!secret) {
        return respondMissingSecret(res, 'dashboard_auth_secret_missing');
    }

    const token = extractToken(req, {
        headerNames: ['x-dashboard-secret', 'x-dashboard-token']
    });

    if (!isAuthorized(token, secret)) {
        logger.warn('dashboard_auth_failed', { ip: req.ip, path: req.originalUrl });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
}

function requireProvisionAuth(req, res, next) {
    const secret = config.auth.provisionSecret;
    if (!secret) {
        return respondMissingSecret(res, 'provision_auth_secret_missing');
    }

    const token = extractToken(req, {
        headerNames: ['x-provision-secret', 'x-provision-token']
    });

    if (!isAuthorized(token, secret)) {
        logger.warn('provision_auth_failed', { ip: req.ip, path: req.originalUrl });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
}

function authorizeDashboardRequest(req) {
    const secret = config.auth.dashboardSecret;
    if (!secret) {
        logger.error('dashboard_ws_auth_secret_missing', { configured: false });
        return false;
    }

    const token = extractToken(req, {
        headerNames: ['x-dashboard-secret', 'x-dashboard-token']
    });

    const authorized = isAuthorized(token, secret);
    if (!authorized) {
        logger.warn('dashboard_ws_auth_failed', {
            ip: req.socket?.remoteAddress
        });
    }

    return authorized;
}

module.exports = {
    requireDashboardAuth,
    requireProvisionAuth,
    authorizeDashboardRequest
};
