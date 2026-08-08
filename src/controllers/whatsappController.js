const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const unipileClient = require('../services/whatsapp/unipileClient');
const { handleWebhook } = require('../services/whatsapp/webhookHandler');
const settingsService = require('../services/settings/settingsService');
const logger = require('../utils/logger');

/**
 * POST /api/whatsapp/webhook?secret=...
 * Public endpoint (no auth) — this is the URL you register in the Unipile
 * dashboard under Webhooks -> New message, source "messaging".
 * Always responds 200 quickly; Unipile retries (up to 5x) on anything else.
 */
const receiveWebhook = asyncHandler(async (req, res) => {
  // Log every hit unconditionally, BEFORE the secret check — if this line
  // never shows up in your server logs when you message the connected
  // WhatsApp number, Unipile isn't reaching this server at all (most likely
  // cause: server is running on localhost and Unipile's servers can't reach
  // it — you need a public URL, e.g. via ngrok/cloudflared tunnel or a real
  // deployment, registered as the webhook URL in the Unipile dashboard).
  logger.info(`[whatsapp] Webhook hit: event=${req.body?.event} accountId=${req.body?.account_id}`);

  if (env.unipile.webhookSecret && req.query.secret !== env.unipile.webhookSecret) {
    logger.warn('[whatsapp] Webhook called with missing/incorrect secret — ignoring');
    return res.status(200).json({ ok: true }); // 200 so Unipile doesn't retry; just silently drop it
  }

  // Fire-and-forget-ish: respond immediately, process after. Unipile requires
  // a 200 within 30s and this app's AI turn (LLM call + WhatsApp send) can
  // occasionally run close to that, so don't make Unipile wait on it.
  res.status(200).json({ ok: true });
  handleWebhook(req.body).catch((err) => logger.error('[whatsapp] Unhandled webhook processing error', { error: err.message }));
});

/**
 * POST /api/whatsapp/send-test
 * Manual/dev utility to confirm the Unipile integration can actually send —
 * not part of the main conversation flow (that happens through the AI
 * engine / manual-reply endpoint in the Conversations module).
 */
const sendTest = asyncHandler(async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) throw ApiError.badRequest('phone and text are required');

  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest('WhatsApp is disconnected for your account — reconnect it from Settings first');
  }

  const { chatId, messageId } = await unipileClient.sendToLead({ existingChatId: null, phone, text });
  return new ApiResponse(200, { chatId, messageId }, 'Message sent').send(res);
});

/**
 * GET /api/whatsapp/status — reports whether Unipile is configured, the
 * connected number (best-effort, straight from Unipile), and whether this
 * org has hit "Disconnect" on the Settings page.
 */
const getStatus = asyncHandler(async (req, res) => {
  const configured = Boolean(env.unipile.apiKey && env.unipile.accountId);
  const settings = await settingsService.getOrCreateSettings();

  let phoneNumber = null;
  let liveStatus = null;
  if (configured) {
    try {
      const info = await unipileClient.getAccountInfo();
      phoneNumber = info.phoneNumber;
      liveStatus = info.status;
    } catch (err) {
      logger.warn('[whatsapp] Could not fetch Unipile account info for status page', { error: err.message });
    }
  }

  return new ApiResponse(200, {
    provider: 'unipile',
    configured,
    accountId: configured ? env.unipile.accountId : null,
    dsn: env.unipile.dsn,
    phoneNumber,
    liveStatus,
    disconnected: settings.whatsappDisconnected,
  }).send(res);
});

/**
 * POST /api/whatsapp/disconnect
 * Stops AI auto-replies and manual/test sends for this org. Does NOT touch
 * the underlying Unipile account (that's shared infra for the whole
 * deployment) — this is an app-level "pause everything WhatsApp" switch.
 */
const disconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ whatsappDisconnected: true });
  return new ApiResponse(200, { settings }, 'WhatsApp disconnected').send(res);
});

/** POST /api/whatsapp/reconnect */
const reconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ whatsappDisconnected: false });
  return new ApiResponse(200, { settings }, 'WhatsApp reconnected').send(res);
});

module.exports = { receiveWebhook, sendTest, getStatus, disconnect, reconnect };
