const axios = require('axios');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Thin wrapper around Unipile's messaging API (https://developer.unipile.com).
 * Replaces the old local Baileys/QR session entirely — WhatsApp connectivity
 * now lives on Unipile's side, this app just calls their REST API.
 */
const http = axios.create({
  timeout: 20_000,
});

function assertConfigured() {
  if (!env.unipile.apiKey || !env.unipile.accountId) {
    throw new Error('Unipile is not configured — set UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID in the environment');
  }
}

function headers() {
  return {
    'X-API-KEY': env.unipile.apiKey,
    accept: 'application/json',
  };
}

/** Normalizes a lead's stored phone number into the "<digits>@s.whatsapp.net" id Unipile expects for WhatsApp attendees. */
function toWhatsAppAttendeeId(phone) {
  if (!phone) throw new Error('Phone number is required');
  if (phone.includes('@')) return phone; // already a full provider id
  const digits = phone.replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Starts a brand-new 1:1 chat and sends the first message — this is what
 * fires the very first outbound WhatsApp message to a freshly created lead.
 * POST /api/v1/chats
 * Returns { chatId, raw }.
 */
async function startChat({ phone, text }) {
  assertConfigured();

  const body = new URLSearchParams();
  body.append('account_id', env.unipile.accountId);
  body.append('attendees_ids', toWhatsAppAttendeeId(phone));
  body.append('text', text);

  const { data } = await http.post(`${env.unipile.dsn}/api/v1/chats`, body, {
    headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
  });

  const chatId = data?.chat_id || data?.id || null;
  if (!chatId) {
    logger.warn('[unipile] startChat response did not include a chat_id', { data });
  }
  return { chatId, raw: data };
}

/**
 * Sends a message into an existing chat — used for every AI/manual reply
 * once a chat_id is already known (from startChat, or from an inbound
 * webhook's chat_id).
 * POST /api/v1/chats/{chat_id}/messages
 * Returns { messageId, raw }.
 */
async function sendMessageInChat({ chatId, text }) {
  assertConfigured();
  if (!chatId) throw new Error('chatId is required to send a message in an existing chat');

  const body = new URLSearchParams();
  body.append('text', text);

  const { data } = await http.post(`${env.unipile.dsn}/api/v1/chats/${chatId}/messages`, body, {
    headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
  });

  const messageId = data?.message_id || data?.id || null;
  return { messageId, raw: data };
}

/**
 * Sends a WhatsApp message to a lead, starting a new chat if we don't
 * already have a chat_id for them (e.g. this is the opening message), or
 * sending into the existing chat otherwise. This is the single entry point
 * the rest of the app should use.
 */
async function sendToLead({ existingChatId, phone, text }) {
  if (existingChatId) {
    const { messageId, raw } = await sendMessageInChat({ chatId: existingChatId, text });
    return { chatId: existingChatId, messageId, raw };
  }
  const { chatId, raw } = await startChat({ phone, text });
  return { chatId, messageId: raw?.message_id || null, raw };
}

/**
 * GET /api/v1/accounts/{account_id} — used by the Settings page's "WhatsApp
 * Settings" panel to show the actually-connected number and its live
 * status, instead of just "configured: true/false". Best-effort: Unipile's
 * exact response shape can vary a bit, so several common field names are
 * tried; if the account can't be reached at all, callers should treat the
 * phone number as unknown rather than fail the whole page.
 */
async function getAccountInfo() {
  assertConfigured();

  const { data } = await http.get(`${env.unipile.dsn}/api/v1/accounts/${env.unipile.accountId}`, {
    headers: headers(),
  });

  const phoneNumber =
    data?.phone_number ||
    data?.connection_params?.im?.phone_number ||
    data?.connection_params?.messaging?.phone_number ||
    (typeof data?.name === 'string' && /^\+?\d{6,15}$/.test(data.name) ? data.name : null) ||
    null;

  const rawStatus = data?.sources?.[0]?.status || data?.status || null;

  return { phoneNumber, status: rawStatus, raw: data };
}

module.exports = { startChat, sendMessageInChat, sendToLead, toWhatsAppAttendeeId, getAccountInfo };
