// src/routes/index.js

const express = require('express');
const router = express.Router();

const deviceRoutes = require('./deviceRoutes');



router.use('/devices', deviceRoutes);

module.exports = router;