require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const config = require('./config/index');
const mainRouter = require('./routes/index');
const publicRouter = require('./routes/publicRoutes');
const devRouter = require('./routes/devRoutes');
const logger = require('./utils/logger');
const { setupWebSocketHandlers } = require('./websocket/index');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/downloads', publicRouter);
app.use('/api', mainRouter);

if (config.devTools.enabled) {
    app.use('/api/dev', devRouter);
    app.use('/dev', express.static(path.join(__dirname, '..', 'public', 'dev')));
    logger.warn('dev_tools_enabled', { routePrefix: '/api/dev' });
}

// Health
app.get('/health', (req, res) => {
    res.json({ status: 'ok', env: config.env });
});

const server = https.createServer({
    key: fs.readFileSync(config.https.key),
    cert: fs.readFileSync(config.https.cert)
}, app);

const wss = new WebSocketServer({ server });

// Shared state
const dashboardClients = new Set();
const activeDevices = new Map();

app.locals.activeDevices = activeDevices;
app.locals.dashboardClients = dashboardClients;

setupWebSocketHandlers(wss, dashboardClients, activeDevices);

console.log(`Server starting on https://0.0.0.0:${config.port}`);

server.listen(config.port, '0.0.0.0', () => {
    if (config.publicUrl) {
        console.log(`Public: ${config.publicUrl}`);
    }
    console.log(`Local: https://127.0.0.1:${config.port}`);
});
