// const Lead = require('../../models/Lead');
// const Conversation = require('../../models/Conversation');
// const Message = require('../../models/Message');
// const User = require('../../models/User');
// const Notification = require('../../models/Notification');
// const logger = require('../../utils/logger');
// const { emitToUser } = require('../../sockets');
// const conversationEngine = require('../ai/conversationEngine');
// const env = require('../../config/env');

// /**
//  * Real Unipile "New message" webhook body for WhatsApp (confirmed from a
//  * live payload — the docs example is outdated):
//  * {
//  *   "event": "message_received",
//  *   "account_id": "...",
//  *   "account_type": "WHATSAPP",
//  *   "chat_id": "PZm_joiHV7eLn1mGMXIyTg",
//  *   "message_id": "tOq3yjN6WnCrMaEOfE07iQ",
//  *   "message": "Hello world",
//  *   "timestamp": "2026-07-13T07:06:28.000Z",
//  *   "is_sender": false, // true when the message was sent BY our own connected WhatsApp number
//  *   "sender": {
//  *     "attendee_id": "...",
//  *     "attendee_provider_id": "160512172130375@lid", // NOT a phone number — WhatsApp's newer
//  *                                                     // privacy "linked ID" format. Do NOT parse this for a phone.
//  *     "attendee_specifics": { "provider": "WHATSAPP", "phone_number": "+916307303338", "lid": "..." },
//  *     "attendee_public_identifier": "916307303338@s.whatsapp.net" // real phone, always in this format
//  *   }
//  * }
//  */

// /**
//  * Pulls the real phone number off a webhook "sender"/attendee object.
//  * WhatsApp now assigns each contact an opaque "@lid" id instead of exposing
//  * their phone number directly, so `attendee_provider_id` can NOT be trusted
//  * as a phone number anymore (it used to be, hence the old bug here) —
//  * `attendee_specifics.phone_number` and `attendee_public_identifier` are the
//  * two fields that still reliably carry the actual number.
//  */
// function extractPhone(attendee) {
//   const direct = attendee?.attendee_specifics?.phone_number; // "+916307303338"
//   if (direct) return direct.replace(/[^\d]/g, '');

//   const publicId = attendee?.attendee_public_identifier; // "916307303338@s.whatsapp.net"
//   if (publicId && publicId.includes('@')) return publicId.split('@')[0].replace(/[^\d]/g, '');

//   // Last resort: only trust attendee_provider_id if it's the OLD phone-based
//   // format ("...@s.whatsapp.net"), never the newer "...@lid" opaque id.
//   const providerId = attendee?.attendee_provider_id;
//   if (providerId && providerId.endsWith('@s.whatsapp.net')) return providerId.split('@')[0].replace(/[^\d]/g, '');

//   return null;
// }

// /**
//  * Leads can have their phone saved in different formats depending on how
//  * they came in ("+919876543210", "919876543210", or even just "9876543210"
//  * without a country code) — but the incoming webhook always gives us bare
//  * digits with country code (e.g. "919876543210"). Try the exact digit and
//  * "+digit" forms first, then fall back to a last-10-digit suffix match so a
//  * lead saved without a country code still resolves correctly.
//  */
// async function findLeadByPhone(digits) {
//   if (!digits) return null;

//   let lead = await Lead.findOne({ phone: { $in: [digits, `+${digits}`] } });
//   if (lead) return lead;

//   const last10 = digits.slice(-10);
//   if (last10.length === 10) {
//     lead = await Lead.findOne({ phone: new RegExp(`${last10}$`) });
//   }
//   return lead;
// }

// /**
//  * Resolves which broker/user a brand-new inbound lead (one who messaged us
//  * first, before ever being added/imported) should belong to. Since this
//  * deployment has exactly ONE connected WhatsApp number (UNIPILE_ACCOUNT_ID
//  * is global, not per-org), there's no per-message signal telling us which
//  * broker's number this is — so we rely on DEFAULT_LEAD_OWNER_ID, falling
//  * back to the first admin/broker account if that's not configured.
//  *
//  * Cached in-process for a few minutes so every inbound message from an
//  * unknown number doesn't re-hit the Users collection.
//  */
// let cachedOwner = null;
// let cachedOwnerAt = 0;
// const OWNER_CACHE_MS = 5 * 60 * 1000;

// async function resolveDefaultOwner() {
//   if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_MS) return cachedOwner;

//   let owner = null;
//   if (env.leads.defaultOwnerId) {
//     owner = await User.findById(env.leads.defaultOwnerId);
//     if (!owner) {
//       logger.warn(`[whatsapp] DEFAULT_LEAD_OWNER_ID=${env.leads.defaultOwnerId} does not match any User — falling back`);
//     }
//   }

//   if (!owner) {
//     owner = await User.findOne({ role: { $in: ['broker', 'builder', 'admin'] }, isActive: true }).sort({ createdAt: 1 });
//   }

//   if (owner) {
//     cachedOwner = owner;
//     cachedOwnerAt = Date.now();
//   }
//   return owner;
// }

// /**
//  * Someone messaged the connected WhatsApp number who isn't in the CRM yet
//  * (no lead has this phone). Auto-creates a Lead + Conversation for them so
//  * the AI engine can pick the message up exactly like it would for any
//  * existing lead — this is what makes "new number messages us -> AI responds
//  * too" work, not just "we message a number first".
//  */
// async function createLeadForUnknownSender(phone, payload) {
//   const owner = await resolveDefaultOwner();
//   if (!owner) {
//     logger.warn(
//       `[whatsapp] Inbound message from unrecognized number ${phone} — no default lead owner configured (set DEFAULT_LEAD_OWNER_ID or create a broker/admin user), ignoring`
//     );
//     return null;
//   }

//   // Phone can't collide with an existing lead here (findLeadByPhone already
//   // returned nothing), but two webhook retries racing each other could both
//   // reach this point — the unique (ownerId, phone) index is the real guard;
//   // fall back to re-fetching if we lose that race.
//   let lead;
//   try {
//     lead = await Lead.create({
//       ownerId: owner._id,
//       organizationId: owner.organizationId,
//       name: `WhatsApp ${phone}`,
//       phone,
//       source: 'whatsapp_inbound',
//     });
//   } catch (err) {
//     if (err.code === 11000) {
//       lead = await Lead.findOne({ ownerId: owner._id, phone });
//     } else {
//       throw err;
//     }
//   }
//   if (!lead) return null;

//   const conversation = await Conversation.create({ leadId: lead._id, ownerId: lead.ownerId });

//   logger.info(`[whatsapp] Auto-created new lead ${lead._id} for unrecognized inbound number ${phone}`);

//   await Notification.create({
//     userId: owner._id,
//     type: 'new_lead',
//     title: `New WhatsApp message from ${phone}`,
//     body: 'This number messaged you first and was added as a new lead automatically.',
//     link: `/leads/${lead._id}`,
//   });
//   emitToUser(owner._id, 'notification:new', { leadId: lead._id });
//   emitToUser(owner._id, 'lead:new', { lead });

//   return { lead, conversation };
// }

// /**
//  * Handles one inbound webhook delivery from Unipile. Always resolves/returns
//  * quickly and never throws — Unipile retries on any non-200 response, and a
//  * thrown error here would otherwise turn one bad payload into five retried
//  * duplicate deliveries.
//  */
// async function handleWebhook(payload) {
//   try {
//     logger.info(`[whatsapp] Webhook received: event=${payload?.event} chatId=${payload?.chat_id} isSender=${payload?.is_sender}`);

//     if (!payload || payload.account_type !== 'WHATSAPP') return;
//     if (payload.event !== 'message_received') return; // ignore reactions/read-receipts/edits/deletes here
//     if (payload.is_sender) return; // our own outbound send, already recorded on the send path

//     const text = typeof payload.message === 'string' ? payload.message.trim() : '';
//     if (!text) return; // media-only message with no caption — skip in v1

//     const phone = extractPhone(payload.sender);
//     if (!phone) {
//       logger.warn('[whatsapp] Webhook message had no resolvable sender phone number, ignoring', { chatId: payload.chat_id });
//       return;
//     }

//     let lead = await findLeadByPhone(phone);
//     let conversation;

//     if (!lead) {
//       // Brand-new number we've never seen before — auto-create the lead
//       // (and its conversation) so the AI can respond to them too, instead
//       // of only ever replying to numbers that were imported/added first.
//       const created = await createLeadForUnknownSender(phone, payload);
//       if (!created) return; // no default owner configured — see createLeadForUnknownSender for how to fix
//       ({ lead, conversation } = created);
//     } else {
//       conversation = await Conversation.findOne({ leadId: lead._id });
//       if (!conversation) {
//         conversation = await Conversation.create({ leadId: lead._id, ownerId: lead.ownerId });
//       }
//     }

//     // Keep the chat_id in sync — this is also how a lead who messages first
//     // (before we ever sent them anything) gets a chat_id recorded at all.
//     if (payload.chat_id && conversation.unipileChatId !== payload.chat_id) {
//       conversation.unipileChatId = payload.chat_id;
//     }

//     const whatsappMessageId = payload.message_id;
//     if (whatsappMessageId) {
//       const alreadyExists = await Message.findOne({ whatsappMessageId }).lean();
//       if (alreadyExists) return; // dedup — webhook retry protection
//     }

//     const savedMessage = await Message.create({
//       conversationId: conversation._id,
//       leadId: lead._id,
//       direction: 'inbound',
//       sender: 'customer',
//       text,
//       whatsappMessageId: whatsappMessageId || null,
//       timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
//     });

//     conversation.lastMessageAt = savedMessage.timestamp;
//     conversation.unreadCount += 1;
//     await conversation.save();

//     emitToUser(lead.ownerId, 'conversation:newMessage', {
//       conversationId: conversation._id,
//       leadId: lead._id,
//       message: savedMessage,
//     });

//     // Hand off to the AI engine. Awaited so replies for a given lead stay in
//     // order, but wrapped in its own try/catch — an AI failure must never
//     // surface back as a webhook failure (which would trigger Unipile retries).
//     try {
//       await conversationEngine.handleInbound({ conversation, lead, message: savedMessage });
//     } catch (aiErr) {
//       logger.error(`[ai] Conversation engine failed for lead ${lead._id}`, { error: aiErr.message });
//     }
//   } catch (err) {
//     logger.error('[whatsapp] Failed to process webhook message', { error: err.message });
//   }
// }

// module.exports = { handleWebhook, extractPhone, findLeadByPhone };


const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const logger = require('../../utils/logger');
const { emitToUser } = require('../../sockets');
const conversationEngine = require('../ai/conversationEngine');
const env = require('../../config/env');

/**
 * Real Unipile "New message" webhook body for WhatsApp (confirmed from a
 * live payload — the docs example is outdated):
 * {
 *   "event": "message_received",
 *   "account_id": "...",
 *   "account_type": "WHATSAPP",
 *   "chat_id": "PZm_joiHV7eLn1mGMXIyTg",
 *   "message_id": "tOq3yjN6WnCrMaEOfE07iQ",
 *   "message": "Hello world",
 *   "timestamp": "2026-07-13T07:06:28.000Z",
 *   "is_sender": false, // true when the message was sent BY our own connected WhatsApp number
 *   "sender": {
 *     "attendee_id": "...",
 *     "attendee_provider_id": "160512172130375@lid", // NOT a phone number — WhatsApp's newer
 *                                                     // privacy "linked ID" format. Do NOT parse this for a phone.
 *     "attendee_specifics": { "provider": "WHATSAPP", "phone_number": "+916307303338", "lid": "..." },
 *     "attendee_public_identifier": "916307303338@s.whatsapp.net" // real phone, always in this format
 *   }
 * }
 */

/**
 * Pulls the real phone number off a webhook "sender"/attendee object.
 * WhatsApp now assigns each contact an opaque "@lid" id instead of exposing
 * their phone number directly, so `attendee_provider_id` can NOT be trusted
 * as a phone number anymore (it used to be, hence the old bug here) —
 * `attendee_specifics.phone_number` and `attendee_public_identifier` are the
 * two fields that still reliably carry the actual number.
 */
function extractPhone(attendee) {
  const direct = attendee?.attendee_specifics?.phone_number; // "+916307303338"
  if (direct) return direct.replace(/[^\d]/g, '');

  const publicId = attendee?.attendee_public_identifier; // "916307303338@s.whatsapp.net"
  if (publicId && publicId.includes('@')) return publicId.split('@')[0].replace(/[^\d]/g, '');

  // Last resort: only trust attendee_provider_id if it's the OLD phone-based
  // format ("...@s.whatsapp.net"), never the newer "...@lid" opaque id.
  const providerId = attendee?.attendee_provider_id;
  if (providerId && providerId.endsWith('@s.whatsapp.net')) return providerId.split('@')[0].replace(/[^\d]/g, '');

  return null;
}

/**
 * Canonical phone format we WRITE to the DB going forward: bare digits with
 * country code, no "+", no spaces/dashes. `extractPhone` already returns
 * digits-only, so this is mostly a safety net for any future caller that
 * passes in a "+91..." or formatted string.
 *
 * NOTE: this does not fix already-inconsistent phone values sitting in the
 * DB from manual add / CSV import — that normalization has to happen at
 * those entry points too (in the Lead controller / CSV importer), which is
 * outside this file.
 */
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/[^\d]/g, '');
  return digits || null;
}

/**
 * Leads can have their phone saved in different formats depending on how
 * they came in ("+919876543210", "919876543210", or even just "9876543210"
 * without a country code) — but the incoming webhook always gives us bare
 * digits with country code (e.g. "919876543210"). Try the exact digit and
 * "+digit" forms first, then fall back to a last-10-digit suffix match so a
 * lead saved without a country code still resolves correctly.
 */
async function findLeadByPhone(digits) {
  if (!digits) return null;

  let lead = await Lead.findOne({ phone: { $in: [digits, `+${digits}`] } });
  if (lead) return lead;

  const last10 = digits.slice(-10);
  if (last10.length === 10) {
    lead = await Lead.findOne({ phone: new RegExp(`${last10}$`) });
  }
  return lead;
}

/**
 * Resolves which broker/user a brand-new inbound lead (one who messaged us
 * first, before ever being added/imported) should belong to. Since this
 * deployment has exactly ONE connected WhatsApp number, there's no
 * per-message signal telling us which broker's number this is — so we rely
 * on DEFAULT_LEAD_OWNER_ID, falling back to the first admin/broker account
 * if that's not configured.
 *
 * Cached in-process for a few minutes so every inbound message from an
 * unknown number doesn't re-hit the Users collection.
 */
let cachedOwner = null;
let cachedOwnerAt = 0;
const OWNER_CACHE_MS = 5 * 60 * 1000;

async function resolveDefaultOwner() {
  if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_MS) return cachedOwner;

  let owner = null;
  if (env.leads.defaultOwnerId) {
    owner = await User.findById(env.leads.defaultOwnerId);
    if (!owner) {
      logger.warn(`[whatsapp] DEFAULT_LEAD_OWNER_ID=${env.leads.defaultOwnerId} does not match any User — falling back`);
    }
  }

  if (!owner) {
    owner = await User.findOne({ role: { $in: ['broker', 'builder', 'admin'] }, isActive: true }).sort({ createdAt: 1 });
  }

  if (owner) {
    cachedOwner = owner;
    cachedOwnerAt = Date.now();
  }
  return owner;
}

/**
 * Creates a Conversation for a lead, safely handling the case where a
 * concurrent webhook delivery (retry, or two near-simultaneous messages)
 * already created one in a race — `leadId` is unique on Conversation, so
 * the loser of the race re-fetches instead of throwing.
 */
async function findOrCreateConversation(lead) {
  let conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation) return conversation;

  try {
    conversation = await Conversation.create({ leadId: lead._id, ownerId: lead.ownerId });
  } catch (err) {
    if (err.code === 11000) {
      conversation = await Conversation.findOne({ leadId: lead._id });
    } else {
      throw err;
    }
  }
  return conversation;
}

/**
 * Someone messaged the connected WhatsApp number who isn't in the CRM yet
 * (no lead has this phone). Auto-creates a Lead + Conversation for them so
 * the AI engine can pick the message up exactly like it would for any
 * existing lead — this is what makes "new number messages us -> AI responds
 * too" work, not just "we message a number first".
 */
async function createLeadForUnknownSender(phone) {
  const owner = await resolveDefaultOwner();
  if (!owner) {
    logger.warn(
      `[whatsapp] Inbound message from unrecognized number ${phone} — no default lead owner configured (set DEFAULT_LEAD_OWNER_ID or create a broker/admin user), ignoring`
    );
    return null;
  }

  // Phone can't collide with an existing lead here (findLeadByPhone already
  // returned nothing), but two webhook retries racing each other could both
  // reach this point — the unique (ownerId, phone) index is the real guard;
  // fall back to re-fetching if we lose that race.
  let lead;
  try {
    lead = await Lead.create({
      ownerId: owner._id,
      name: `WhatsApp ${phone}`,
      phone,
      source: 'whatsapp_inbound',
    });
  } catch (err) {
    if (err.code === 11000) {
      lead = await Lead.findOne({ ownerId: owner._id, phone });
    } else {
      throw err;
    }
  }
  if (!lead) return null;

  const conversation = await findOrCreateConversation(lead);

  logger.info(`[whatsapp] Auto-created new lead ${lead._id} for unrecognized inbound number ${phone}`);

  await Notification.create({
    userId: owner._id,
    type: 'new_lead',
    title: `New WhatsApp message from ${phone}`,
    body: 'This number messaged you first and was added as a new lead automatically.',
    link: `/leads/${lead._id}`,
  });
  emitToUser(owner._id, 'notification:new', { leadId: lead._id });
  emitToUser(owner._id, 'lead:new', { lead });

  return { lead, conversation };
}

/**
 * A message with no text — either pure media (image/voice/doc with no
 * caption) or something else we don't have text for. We still record it
 * (rather than silently dropping it) so the broker sees "customer sent
 * something" in the UI instead of the conversation looking dead.
 *
 * Full media handling (downloading/storing the actual attachment) is not
 * implemented yet — this is a placeholder text so nothing is lost. The
 * Message model does not currently have a mediaType/mediaUrl field; see the
 * note returned to the caller of this file for what's needed there.
 */
function placeholderTextFor(payload) {
  const type = payload?.message_type || payload?.attachment_type;
  if (type) return `[${type} message — not yet supported for preview]`;
  return '[Media message — not yet supported for preview]';
}

/**
 * Handles one inbound webhook delivery from Unipile. Always resolves/returns
 * quickly and never throws — Unipile retries on any non-200 response, and a
 * thrown error here would otherwise turn one bad payload into five retried
 * duplicate deliveries.
 */
async function handleWebhook(payload) {
  try {
    logger.info(`[whatsapp] Webhook received: event=${payload?.event} chatId=${payload?.chat_id} isSender=${payload?.is_sender}`);

    if (!payload || payload.account_type !== 'WHATSAPP') return;
    if (payload.event !== 'message_received') return; // ignore reactions/read-receipts/edits/deletes here
    if (payload.is_sender) return; // our own outbound send, already recorded on the send path

    const rawText = typeof payload.message === 'string' ? payload.message.trim() : '';
    // Media-only messages (no caption) are no longer dropped — they're saved
    // with a placeholder so the broker still sees that something arrived.
    const text = rawText || placeholderTextFor(payload);

    const phone = normalizePhone(extractPhone(payload.sender));
    if (!phone) {
      logger.warn('[whatsapp] Webhook message had no resolvable sender phone number, ignoring', { chatId: payload.chat_id });
      return;
    }

    let lead = await findLeadByPhone(phone);
    let conversation;

    if (!lead) {
      // Brand-new number we've never seen before — auto-create the lead
      // (and its conversation) so the AI can respond to them too, instead
      // of only ever replying to numbers that were imported/added first.
      const created = await createLeadForUnknownSender(phone);
      if (!created) return; // no default owner configured — see createLeadForUnknownSender for how to fix
      ({ lead, conversation } = created);
    } else {
      conversation = await findOrCreateConversation(lead);
    }

    // Keep the chat_id in sync — this is also how a lead who messages first
    // (before we ever sent them anything) gets a chat_id recorded at all.
    if (payload.chat_id && conversation.unipileChatId !== payload.chat_id) {
      conversation.unipileChatId = payload.chat_id;
    }

    const whatsappMessageId = payload.message_id;
    if (whatsappMessageId) {
      const alreadyExists = await Message.findOne({ whatsappMessageId }).lean();
      if (alreadyExists) return; // dedup — webhook retry protection (app-level;
      // see note below on the DB-level unique index this still needs)
    }

    //=======Yha se remove krna hai 

    logger.info('[whatsapp] ABOUT TO SAVE INBOUND MESSAGE', {
  conversationId: conversation?._id?.toString(),
  leadId: lead?._id?.toString(),
  phone,
  text,
  whatsappMessageId,
  timestamp: payload.timestamp,
});

let savedMessage;

try {
  savedMessage = await Message.create({
    conversationId: conversation._id,
    leadId: lead._id,
    direction: 'inbound',
    sender: 'customer',
    text,
    whatsappMessageId: whatsappMessageId || null,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
  });

  logger.info('[whatsapp] INBOUND MESSAGE SAVED SUCCESSFULLY', {
    messageId: savedMessage._id.toString(),
    conversationId: savedMessage.conversationId.toString(),
    leadId: savedMessage.leadId.toString(),
    text: savedMessage.text,
  });
} catch (saveErr) {
  logger.error('[whatsapp] FAILED TO SAVE INBOUND MESSAGE', {
    error: saveErr.message,
    name: saveErr.name,
    code: saveErr.code,
    stack: saveErr.stack,
    conversationId: conversation?._id?.toString(),
    leadId: lead?._id?.toString(),
    phone,
    text,
    whatsappMessageId,
  });

  throw saveErr;
}

    // const savedMessage = await Message.create({
    //   conversationId: conversation._id,
    //   leadId: lead._id,
    //   direction: 'inbound',
    //   sender: 'customer',
    //   text,
    //   whatsappMessageId: whatsappMessageId || null,
    //   timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    // });

    conversation.lastMessageAt = savedMessage.timestamp;
    conversation.unreadCount += 1;
    await conversation.save();

    emitToUser(lead.ownerId, 'conversation:newMessage', {
      conversationId: conversation._id,
      leadId: lead._id,
      message: savedMessage,
    });

    // Hand off to the AI engine. Awaited so replies for a given lead stay in
    // order, but wrapped in its own try/catch — an AI failure must never
    // surface back as a webhook failure (which would trigger Unipile retries).
    try {
      await conversationEngine.handleInbound({ conversation, lead, message: savedMessage });
    } catch (aiErr) {
      logger.error(`[ai] Conversation engine failed for lead ${lead._id}`, { error: aiErr.message });
    }
  } catch (err) {
    logger.error('[whatsapp] Failed to process webhook message', { error: err.message });
  }
}

module.exports = { handleWebhook, extractPhone, normalizePhone, findLeadByPhone };
