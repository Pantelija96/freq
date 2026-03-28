require('dotenv').config();

const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT) || 3000,

    db: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freq',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    },

    https: {
        key: process.env.CERT_KEY || './cert/server.key',
        cert: process.env.CERT_CERT || './cert/server.cert'
    },

    wssUrl: process.env.WSS_URL || 'wss://192.168.1.4:3000',

    auth: {
        mode: process.env.AUTH_MODE || 'local',
        dashboardSecret: process.env.DASHBOARD_SECRET || '',
        provisionSecret: process.env.PROVISION_SECRET || '',
        jwtExpiresIn: process.env.AUTH_JWT_EXPIRES_IN || '12h',
        ldap: {
            url: process.env.AUTH_LDAP_URL || '',
            baseDn: process.env.AUTH_LDAP_BASE_DN || '',
            domain: process.env.AUTH_LDAP_DOMAIN || '',
            bindDn: process.env.AUTH_LDAP_BIND_DN || '',
            bindPassword: process.env.AUTH_LDAP_BIND_PASSWORD || ''
        }
    },

    devTools: {
        enabled: process.env.DEV_TOOLS_ENABLED
            ? process.env.DEV_TOOLS_ENABLED === 'true'
            : (process.env.NODE_ENV || 'development') !== 'production',
        logDir: process.env.DEV_LOG_DIR || './logs'
    }
};

module.exports = config;
