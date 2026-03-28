const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const deviceRoutes = require('./deviceRoutes');
const commandRoutes = require('./commandRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const { requireDashboardAuth } = require('../middleware/auth');

router.use('/auth', authRoutes);
router.use('/devices', deviceRoutes);
router.use('/command', requireDashboardAuth, commandRoutes);
router.use('/dashboard', requireDashboardAuth, dashboardRoutes);

module.exports = router;
