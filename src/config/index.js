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

    wssUrl: process.env.WSS_URL || 'wss://192.168.1.4:3000'
};

module.exports = config;