const express = require('express');
const router = express.Router();

const deviceRoutes = require('./deviceRoutes');
const commandRoutes = require('./commandRoutes');
const dashboardRoutes = require('./dashboardRoutes');

router.use('/devices', deviceRoutes);
router.use('/command', commandRoutes);
router.use('/dashboard', dashboardRoutes);

module.exports = router;
