const express = require('express');
const router = express.Router();
const {
    getAllDevices,
    getDeviceById,
    getDeviceCommands,
    sendDashboardCommand,
    getCpuFrequencies,
    getDeviceStats,
    getLicences,
    generateReport
} = require('../controllers/dashboardController');

router.get('/devices', getAllDevices);
router.get('/device/:id', getDeviceById);
router.get('/device/:id/commands', getDeviceCommands);
router.post('/command', sendDashboardCommand);

router.get('/device/:deviceId/cpu-frequencies', getCpuFrequencies);
router.get('/device/:deviceId/stats', getDeviceStats);

router.get('/licences', getLicences);
router.get('/report/devices', generateReport);

module.exports = router;
