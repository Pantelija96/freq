const express = require('express');

const {
    getDevOverview,
    listDevices,
    listActiveDevices,
    sendDeviceCommand,
    sendGroupCommand,
    listDeviceCommands,
    listLogs,
    readLogFile,
    seedDemoData
} = require('../controllers/devController');

const router = express.Router();

router.get('/', getDevOverview);
router.get('/devices', listDevices);
router.get('/active-devices', listActiveDevices);
router.get('/devices/:deviceId/commands', listDeviceCommands);
router.post('/devices/:deviceId/commands', sendDeviceCommand);
router.post('/groups/:groupId/commands', sendGroupCommand);
router.get('/seed/demo', seedDemoData);
router.get('/logs', listLogs);
router.get('/logs/:filename', readLogFile);

module.exports = router;
