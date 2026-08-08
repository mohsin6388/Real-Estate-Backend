const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');

const { receiveWebhook, sendTest, getStatus, disconnect, reconnect } = require('../controllers/whatsappController');

// Public — this is the URL registered in the Unipile dashboard. No auth
// middleware: Unipile calls this directly and can't send our JWT/cookies.
// Protected instead by the optional UNIPILE_WEBHOOK_SECRET query param
// (checked inside the controller) — set it and use it in the registered URL,
// e.g. https://your-domain.com/api/whatsapp/webhook?secret=xxxx
router.post('/webhook', receiveWebhook);

router.get('/status', authenticate, roleGuard('broker', 'admin'), getStatus);
router.post('/send-test', authenticate, roleGuard('broker'), sendTest);
router.post('/disconnect', authenticate, roleGuard('broker', 'builder'), disconnect);
router.post('/reconnect', authenticate, roleGuard('broker', 'builder'), reconnect);

module.exports = router;
