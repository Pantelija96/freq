// src/routes/deviceRoutes.js

const express = require('express');
const router = express.Router();
const { provisionDevice, loginDevice } = require('../controllers/deviceController');
const { requireProvisionAuth } = require('../middleware/auth');

// router.post('/provision', requireProvisionAuth, provisionDevice);
router.post('/provision', provisionDevice);
router.post('/login', loginDevice);

module.exports = router;
