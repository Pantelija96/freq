const express = require('express');

const { login, me, logout } = require('../controllers/authController');
const { requireDashboardAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', login);
router.get('/me', requireDashboardAuth, me);
router.post('/logout', requireDashboardAuth, logout);

module.exports = router;
