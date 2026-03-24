const express = require('express');
const router = express.Router();
const { createCommand, createGroupCommand, cancelCommand } = require('../controllers/commandController');

router.post('/:deviceId', createCommand);
router.post('/group/:groupId', createGroupCommand);
router.post('/cancel/:id', cancelCommand);

module.exports = router;
