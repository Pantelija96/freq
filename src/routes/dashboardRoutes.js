const express = require('express');
const router = express.Router();
const { requireAdminRole } = require('../middleware/auth');
const {
    getOverview,
    getAllDevices,
    getDeviceById,
    getDeviceCommands,
    sendDashboardCommand,
    getCpuFrequencies,
    getDeviceStats,
    getLicences,
    generateReport
} = require('../controllers/dashboardController');

router.get('/overview', getOverview);
router.get('/devices', getAllDevices);
router.get('/device/:id', getDeviceById);
router.get('/device/:id/commands', getDeviceCommands);
router.post('/command', requireAdminRole, sendDashboardCommand);

router.get('/device/:deviceId/cpu-frequencies', getCpuFrequencies);
router.get('/device/:deviceId/stats', getDeviceStats);

router.get('/licences', getLicences);
router.get('/report/devices', generateReport);
router.post('/report/devices', generateReport);

module.exports = router;
