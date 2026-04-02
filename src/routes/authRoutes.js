const express = require('express');

const { login, me, logout, changePassword } = require('../controllers/authController');
const { requireDashboardAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', login);
router.get('/me', requireDashboardAuth, me);
router.post('/logout', requireDashboardAuth, logout);
router.post('/change-password', requireDashboardAuth, changePassword);

module.exports = router;
