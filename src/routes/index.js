const express = require('express');
const router = express.Router();

const deviceRoutes = require('./deviceRoutes');
const commandRoutes = require('./commandRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const { requireDashboardAuth } = require('../middleware/auth');

router.use('/devices', deviceRoutes);
router.use('/command', requireDashboardAuth, commandRoutes);
router.use('/dashboard', requireDashboardAuth, dashboardRoutes);

module.exports = router;
