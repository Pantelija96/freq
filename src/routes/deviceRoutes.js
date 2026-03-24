// src/routes/deviceRoutes.js

const express = require('express');
const router = express.Router();
const { provisionDevice, loginDevice } = require('../controllers/deviceController');

router.post('/provision', provisionDevice);
router.post('/login', loginDevice);

module.exports = router;
