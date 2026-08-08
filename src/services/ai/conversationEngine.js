// const Lead = require('../../models/Lead');
// const Conversation = require('../../models/Conversation');
// const Message = require('../../models/Message');
// const Meeting = require('../../models/Meeting');
// const Notification = require('../../models/Notification');

// const settingsService = require('../settings/settingsService');
// const unipileClient = require('../whatsapp/unipileClient');
// const { recordOutboundMessage } = require('../whatsapp/messageStore');
// const { matchProperties } = require('./propertyMatcher');
// const { generateStructured } = require('./geminiClient');
// const { buildSystemInstruction, REPLY_RESPONSE_SCHEMA, toGeminiHistory, buildOpeningHistory } = require('./promptBuilder');
// const { analyzeConversationAsync } = require('./leadAnalyzer');
// const { createCalendarEvent, updateCalendarEvent } = require('../calendar/googleCalendarService');
// const env = require('../../config/env');
// const { emitToUser } = require('../../sockets');
// const logger = require('../../utils/logger');

// const HISTORY_LIMIT = 30; // most recent messages sent as context per turn — enough memory without blowing the token budget

// /**
//  * Entry point called from the WhatsApp inbound handler for every incoming
//  * customer message. Fully self-contained: loads this lead's own memory
//  * (and only this lead's — conversations never mix), decides a reply,
//  * sends it back out over the SAME broker's WhatsApp session, and persists
//  * everything. Errors are caught by the caller (inboundHandler) so one
//  * lead's AI failure never takes down the message loop for others.
//  */
// async function handleInbound({ conversation, lead, message }) {
//   // Manual takeover or globally paused AI — the broker is handling this chat themselves.
//   if (conversation.status === 'manual' || conversation.status === 'closed') return;

//   const settings = await settingsService.getOrCreateSettings(lead.organizationId);
//   if (settings.aiPaused || !settings.autoReplyEnabled) return;
//   if (settings.whatsappDisconnected) return; // broker hit "Disconnect" on the Settings page

//   const apiKey = await settingsService.getGeminiKey(lead.organizationId);
//   if (!apiKey) {
//     logger.warn(`[ai] No Gemini API key configured for org ${lead.organizationId} — skipping AI reply for lead ${lead._id}`);
//     return;
//   }

//   const recentMessages = await Message.find({ conversationId: conversation._id })
//     .sort({ timestamp: -1 })
//     .limit(HISTORY_LIMIT)
//     .lean();
//   recentMessages.reverse(); // oldest -> newest for the model

//   // Pull in any properties that already look like a fit given what we know
//   // so far, so the model can reference them by name instead of inventing details.

//   const requirements = conversation.collectedRequirements || {};

//   // Always scoped to THIS lead's organization — a buyer must only ever see
//   // their own broker/builder's inventory. Previously this fell back to an
//   // unscoped `Property.find({isActive:true})` with no organizationId filter
//   // at all, which could pull in random properties from other orgs (or miss
//   // this org's own listings entirely once a city/budget was known and the
//   // exact-match lookup below found nothing). matchProperties() now handles
//   // both "no city yet" (returns the org's active inventory) and "city typed
//   // slightly differently" (soft match + fallback) internally.
//   const candidateProperties = await matchProperties({
//     organizationId: lead.organizationId,
//     city: requirements.city || lead.city,
//     location: requirements.location || lead.location,
//     budgetMin: requirements.budgetMin ?? lead.budgetMin,
//     budgetMax: requirements.budgetMax ?? lead.budgetMax,
//     bhk: requirements.bhk,
//     amenities: requirements.amenities,
//   });

//   const systemInstruction = buildSystemInstruction({
//     lead,
//     settings,
//     collectedRequirements: requirements,
//     matchedProperties: candidateProperties,
//   });

//   let result;
//   try {


//     result = await generateStructured({
//       apiKey,
//       systemInstruction,
//       history: toGeminiHistory(recentMessages),
//       responseSchema: REPLY_RESPONSE_SCHEMA,
//     });
//   } catch (err) {
//     logger.error(`[ai] Gemini reply generation failed for lead ${lead._id}`, { error: err.message });
//     return; // fail silently to the buyer — broker can still see & manually reply from the Conversations page
//   }

//   const { parsed, raw } = result;

//   // Merge newly extracted requirements into what we already knew (never overwrite with blanks).
//   const mergedRequirements = mergeRequirements(requirements, parsed.extractedRequirements);
//   conversation.collectedRequirements = mergedRequirements;
//   conversation.lastIntent = parsed.intent;
//   conversation.lastSentiment = parsed.sentiment;
//   if (candidateProperties.length) {
//     conversation.recommendedProperties = candidateProperties.map((p) => p._id);
//   }

//   // Mirror the key fields back onto Lead so existing list/filter/CSV export UI stays useful.
//   const leadUpdates = {};
//   if (mergedRequirements.city) leadUpdates.city = mergedRequirements.city;
//   if (mergedRequirements.location) leadUpdates.location = mergedRequirements.location;
//   if (mergedRequirements.budgetMin != null) leadUpdates.budgetMin = mergedRequirements.budgetMin;
//   if (mergedRequirements.budgetMax != null) leadUpdates.budgetMax = mergedRequirements.budgetMax;
//   if (Object.keys(leadUpdates).length) {
//     await Lead.updateOne({ _id: lead._id }, { $set: leadUpdates });
//   }

//   // Small human-like "typing" pause before sending — kept tight at 3-4s
//   // (randomized so every reply doesn't land at the exact same delay) rather
//   // than the old 2/5/10s Settings dropdown, which could feel too slow.
//   const replyDelayMs = 3000 + Math.floor(Math.random() * 1000); // 3000-4000ms
//   await new Promise((resolve) => setTimeout(resolve, replyDelayMs));

//   // Send the reply out through Unipile — into the existing chat if we have
//   // its chat_id already, otherwise this starts one (shouldn't normally
//   // happen here since an inbound message always carries a chat_id, but the
//   // fallback keeps this robust either way).
//   let outbound;
//   try {
//     const { chatId, messageId } = await unipileClient.sendToLead({
//       existingChatId: conversation.unipileChatId,
//       phone: lead.phone,
//       text: parsed.reply,
//     });
//     if (chatId && conversation.unipileChatId !== chatId) conversation.unipileChatId = chatId;

//     outbound = await recordOutboundMessage({
//       conversationId: conversation._id,
//       leadId: lead._id,
//       text: parsed.reply,
//       sender: 'ai',
//       whatsappMessageId: messageId || null,
//       aiPrompt: systemInstruction,
//       aiResponseRaw: raw,
//       intent: parsed.intent,
//       sentiment: parsed.sentiment,
//     });
//   } catch (err) {
//     logger.error(`[ai] Failed to send AI reply for lead ${lead._id} via Unipile`, { error: err.message });
//     await Notification.create({
//       userId: conversation.ownerId,
//       type: 'whatsapp_send_failed',
//       title: `Couldn't message ${lead.name || 'lead'} — WhatsApp send failed`,
//       body: `Sending via Unipile failed for ${lead.phone}: ${err.message}`,
//       link: `/leads/${lead._id}`,
//     });
//     emitToUser(conversation.ownerId, 'notification:new', { leadId: lead._id });
//     return;
//   }

//   // Buyer just agreed to a site visit — create it automatically.
//   if (parsed.wantsSiteVisit) {
//     await createSiteVisit({ lead, conversation, date: parsed.proposedDate, time: parsed.proposedTime, property: candidateProperties[0] });
//   }

//   conversation.requirementsComplete = !!parsed.readyForPropertyRecommendation;
//   await conversation.save();

//   emitToUser(conversation.ownerId, 'conversation:aiReply', {
//     conversationId: conversation._id,
//     leadId: lead._id,
//     message: outbound,
//   });

//   // Lead scoring + follow-up planning runs as a separate Gemini pass, fired
//   // async so the buyer isn't kept waiting on a second model call.
//   analyzeConversationAsync({ leadId: lead._id, conversationId: conversation._id, organizationId: lead.organizationId }).catch((err) =>
//     logger.error(`[ai] Async lead analysis failed for lead ${lead._id}`, { error: err.message })
//   );
// }

// /**
//  * Sends the very first outbound WhatsApp message to a freshly created lead —
//  * this is what makes "as soon as leads are uploaded, start conversations
//  * automatically" actually happen.
//  *
//  * Idempotent/safe to call more than once for the same lead: no-ops if the
//  * conversation already has any messages, isn't AI-driven, or AI is paused.
//  * Unlike the old Baileys/QR setup there's no "is WhatsApp connected" gate —
//  * Unipile's connection lives on their side, so as long as UNIPILE_API_KEY
//  * and UNIPILE_ACCOUNT_ID are configured, sending just works.
//  */
// async function startConversation({ lead, conversation }) {
//   if (conversation.status !== 'ai_active') return;

//   const alreadyStarted = await Message.exists({ conversationId: conversation._id });
//   if (alreadyStarted) return;

//   if (!env.unipile.apiKey || !env.unipile.accountId) {
//     logger.warn(
//       `[ai] Unipile is not configured (UNIPILE_API_KEY/UNIPILE_ACCOUNT_ID) — skipping opening message for lead ${lead._id}`
//     );
//     return;
//   }

//   const settings = await settingsService.getOrCreateSettings(lead.organizationId);
//   if (settings.aiPaused || !settings.autoReplyEnabled) return;
//   if (settings.whatsappDisconnected) return;

//   const apiKey = await settingsService.getGeminiKey(lead.organizationId);

//   const systemInstruction = buildSystemInstruction({
//     lead,
//     settings,
//     collectedRequirements: {},
//     matchedProperties: [],
//   });

//   // Deterministic fallback if there's no Gemini key configured yet, or the
//   // AI call fails — the buyer still gets a first message either way.
//   let replyText =
//     settings.greetingMessage ||
//     `Hi ${lead.name || 'there'}! Thanks for your interest — I'd love to help you find the right property. What are you looking for?`;
//   let raw = null;
//   let usedAi = false;

//   if (apiKey) {
//     try {

//       const result = await generateStructured({
//         apiKey,
//         systemInstruction,
//         history: buildOpeningHistory(), // Gemini requires non-empty contents — no real turns exist yet
//         responseSchema: REPLY_RESPONSE_SCHEMA,
//       });
//       replyText = result.parsed.reply;
//       raw = result.raw;
//       usedAi = true;
//     } catch (err) {
//       logger.error(
//         `[ai] Failed to generate AI opening message for lead ${lead._id} — falling back to the default greeting`,
//         { error: err.message }
//       );
//     }
//   }

//   let outbound;
//   try {
//     const { chatId, messageId } = await unipileClient.sendToLead({
//       existingChatId: conversation.unipileChatId,
//       phone: lead.phone,
//       text: replyText,
//     });
//     if (chatId) conversation.unipileChatId = chatId;

//     outbound = await recordOutboundMessage({
//       conversationId: conversation._id,
//       leadId: lead._id,
//       text: replyText,
//       sender: 'ai',
//       whatsappMessageId: messageId || null,
//       aiPrompt: usedAi ? systemInstruction : null,
//       aiResponseRaw: raw,
//     });
//   } catch (err) {
//     logger.error(`[ai] Failed to send opening WhatsApp message for lead ${lead._id} via Unipile`, { error: err.message });
//     await Notification.create({
//       userId: conversation.ownerId,
//       type: 'whatsapp_send_failed',
//       title: `Couldn't message ${lead.name || 'lead'} — WhatsApp send failed`,
//       body: `Sending via Unipile failed for ${lead.phone}: ${err.message}`,
//       link: `/leads/${lead._id}`,
//     });
//     emitToUser(conversation.ownerId, 'notification:new', { leadId: lead._id });
//     return;
//   }

//   conversation.lastMessageAt = new Date();
//   await conversation.save();

//   emitToUser(conversation.ownerId, 'conversation:aiReply', {
//     conversationId: conversation._id,
//     leadId: lead._id,
//     message: outbound,
//   });
// }

// /**
//  * Finds any of a broker's leads whose conversation is still ai_active with
//  * zero messages (e.g. their opening message failed earlier — Unipile down,
//  * misconfigured API key, etc) and retries starting them now. Not wired to
//  * any automatic trigger since Unipile has no "connect" event to hook into
//  * the way the old Baileys session did — call this manually (e.g. from an
//  * admin action or a cron job) if you want a retry sweep.
//  */
// async function catchUpPendingConversations(brokerId) {
//   const pending = await Conversation.find({ ownerId: brokerId, status: 'ai_active' }).lean();
//   if (!pending.length) return;

//   const leadIds = pending.map((c) => c.leadId);
//   const leads = await Lead.find({ _id: { $in: leadIds } }).lean();
//   const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

//   let started = 0;
//   for (const convoLean of pending) {
//     const hasMessage = await Message.exists({ conversationId: convoLean._id });
//     if (hasMessage) continue;

//     const lead = leadById.get(convoLean.leadId.toString());
//     if (!lead) continue;

//     // Need a hydrated (non-lean) document since startConversation calls .save() on it.
//     const conversation = await Conversation.findById(convoLean._id);
//     started += 1;
//     startConversation({ lead, conversation }).catch((err) =>
//       logger.error(`[ai] Catch-up auto-start failed for lead ${lead._id}`, { error: err.message })
//     );
//   }

//   if (started) {
//     logger.info(`[ai] Broker ${brokerId} connected — auto-starting ${started} pending WhatsApp conversation(s)`);
//   }
// }

// function mergeRequirements(existing, incoming = {}) {
//   const merged = { ...existing };
//   for (const [key, value] of Object.entries(incoming)) {
//     if (value === undefined || value === null || value === '') continue;
//     if (Array.isArray(value) && value.length === 0) continue;
//     merged[key] = value;
//   }
//   return merged;
// }

// /**
//  * Creates a Meeting the first time a buyer agrees to a site visit for this
//  * lead, and simply UPDATES that same Meeting on every later turn instead of
//  * inserting a new one — e.g. if the AI re-confirms the date/time again a
//  * few messages later, or the buyer changes the time mid-conversation. Only
//  * an already-finished meeting (visited / not_visited / cancelled) is left
//  * alone and a fresh one started, since that's a genuinely new visit.
//  */
// async function createSiteVisit({ lead, conversation, date, time, property }) {
//   const preferredDate = date || new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10); // default: 2 days out if not specified yet
//   const preferredTime = time || '11:00';

//   let meeting = await Meeting.findOne({
//     leadId: lead._id,
//     status: { $in: ['scheduled', 'rescheduled'] },
//   }).sort({ createdAt: -1 });

//   let isNew = false;
//   if (meeting) {
//     meeting.preferredDate = preferredDate;
//     meeting.preferredTime = preferredTime;
//     if (property?._id) meeting.propertyId = property._id;
//     meeting.status = 'scheduled';
//     await meeting.save();
//   } else {
//     isNew = true;
//     meeting = await Meeting.create({
//       leadId: lead._id,
//       ownerId: conversation.ownerId,
//       propertyId: property?._id || null,
//       preferredDate,
//       preferredTime,
//       status: 'scheduled',
//     });
//   }

//   conversation.meetingStatus = 'scheduled';
//   await Lead.updateOne({ _id: lead._id }, { $set: { status: 'site_visit' } });

//   // Book/update the real calendar event. Best-effort: a Calendar failure
//   // must never block the WhatsApp conversation or lose the Meeting record.
//   try {
//     if (meeting.googleEventId) {
//       const event = await updateCalendarEvent({ eventId: meeting.googleEventId, date: preferredDate, time: preferredTime });
//       if (event) {
//         meeting.googleEventLink = event.eventLink;
//         await meeting.save();
//       }
//     } else {
//       const event = await createCalendarEvent({
//         summary: `Site Visit — ${lead.name || lead.phone}${property ? ` (${property.projectName})` : ''}`,
//         description: [
//           `Lead: ${lead.name || 'N/A'} (${lead.phone})`,
//           property ? `Property: ${property.projectName}, ${property.city || ''}` : null,
//           'Booked automatically by the AI WhatsApp assistant.',
//         ]
//           .filter(Boolean)
//           .join('\n'),
//         date: preferredDate,
//         time: preferredTime,
//       });
//       if (event) {
//         meeting.googleEventId = event.eventId;
//         meeting.googleEventLink = event.eventLink;
//         await meeting.save();
//       }
//     }
//   } catch (err) {
//     logger.error(`[calendar] Failed to sync Google Calendar event for lead ${lead._id}`, { error: err.message });
//   }

//   if (isNew) {
//     await Notification.create({
//       userId: conversation.ownerId,
//       type: 'site_visit_scheduled',
//       title: `Site visit scheduled — ${lead.name}`,
//       body: `${preferredDate} at ${preferredTime}${property ? ` for ${property.projectName}` : ''}`,
//       link: `/leads/${lead._id}`,
//     });
//   }

//   emitToUser(conversation.ownerId, 'meeting:created', { meeting });

//   return meeting;
// }

// module.exports = { handleInbound, createSiteVisit, startConversation, catchUpPendingConversations };




const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Meeting = require('../../models/Meeting');
const Notification = require('../../models/Notification');

const settingsService = require('../settings/settingsService');
const unipileClient = require('../whatsapp/unipileClient');
const { recordOutboundMessage } = require('../whatsapp/messageStore');
const { matchProperties } = require('./propertyMatcher');
const { generateStructured } = require('./geminiClient');
const { buildSystemInstruction, REPLY_RESPONSE_SCHEMA, toGeminiHistory, buildOpeningHistory } = require('./promptBuilder');
const { analyzeConversationAsync } = require('./leadAnalyzer');
const { createCalendarEvent, updateCalendarEvent } = require('../calendar/googleCalendarService');
const env = require('../../config/env');
const { emitToUser } = require('../../sockets');
const logger = require('../../utils/logger');

const HISTORY_LIMIT = 30; // most recent messages sent as context per turn — enough memory without blowing the token budget

/**
 * Entry point called from the WhatsApp inbound handler for every incoming
 * customer message. Fully self-contained: loads this lead's own memory,
 * decides a reply, sends it back out over WhatsApp, and persists
 * everything. Errors are caught by the caller (inboundHandler) so one
 * lead's AI failure never takes down the message loop for others.
 *
 * NOTE: single-tenant app — there is exactly one Settings document and one
 * Gemini key for the whole deployment, so settingsService calls below take
 * no organizationId. If settingsService.js still expects one, update it to
 * drop that parameter too.
 */
async function handleInbound({ conversation, lead, message }) {
  // Manual takeover or globally paused AI — the broker is handling this chat themselves.
  if (conversation.status === 'manual' || conversation.status === 'closed') return;

  const settings = await settingsService.getOrCreateSettings();
  if (settings.aiPaused || !settings.autoReplyEnabled) return;
  if (settings.whatsappDisconnected) return; // broker hit "Disconnect" on the Settings page

  const apiKey = await settingsService.getGeminiKey();
  if (!apiKey) {
    logger.warn(`[ai] No Gemini API key configured — skipping AI reply for lead ${lead._id}`);
    return;
  }

  const recentMessages = await Message.find({ conversationId: conversation._id })
    .sort({ timestamp: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  recentMessages.reverse(); // oldest -> newest for the model

  // Pull in any properties that already look like a fit given what we know
  // so far, so the model can reference them by name instead of inventing details.

  const requirements = conversation.collectedRequirements || {};

  // Single-tenant deployment — matchProperties() searches the whole (one)
  // inventory, so no org filter is needed here anymore. matchProperties()
  // handles both "no city yet" (returns active inventory) and "city typed
  // slightly differently" (soft match + fallback) internally.
  const candidateProperties = await matchProperties({
    city: requirements.city || lead.city,
    location: requirements.location || lead.location,
    budgetMin: requirements.budgetMin ?? lead.budgetMin,
    budgetMax: requirements.budgetMax ?? lead.budgetMax,
    bhk: requirements.bhk,
    amenities: requirements.amenities,
  });

  const systemInstruction = buildSystemInstruction({
    lead,
    settings,
    collectedRequirements: requirements,
    matchedProperties: candidateProperties,
  });

  let result;
  try {


    result = await generateStructured({
      apiKey,
      systemInstruction,
      history: toGeminiHistory(recentMessages),
      responseSchema: REPLY_RESPONSE_SCHEMA,
    });
  } catch (err) {
    logger.error(`[ai] Gemini reply generation failed for lead ${lead._id}`, { error: err.message });
    return; // fail silently to the buyer — broker can still see & manually reply from the Conversations page
  }

  const { parsed, raw } = result;

  // Merge newly extracted requirements into what we already knew (never overwrite with blanks).
  const mergedRequirements = mergeRequirements(requirements, parsed.extractedRequirements);
  conversation.collectedRequirements = mergedRequirements;
  conversation.lastIntent = parsed.intent;
  conversation.lastSentiment = parsed.sentiment;
  if (candidateProperties.length) {
    // Overwrite, not append — recommendedProperties always reflects the
    // CURRENT recommendation set, not a running history of everything ever
    // suggested. See Conversation model notes.
    conversation.recommendedProperties = candidateProperties.map((p) => p._id);
  }

  // Mirror the key fields back onto Lead so existing list/filter/CSV export UI stays useful.
  const leadUpdates = {};
  if (mergedRequirements.city) leadUpdates.city = mergedRequirements.city;
  if (mergedRequirements.location) leadUpdates.location = mergedRequirements.location;
  if (mergedRequirements.budgetMin != null) leadUpdates.budgetMin = mergedRequirements.budgetMin;
  if (mergedRequirements.budgetMax != null) leadUpdates.budgetMax = mergedRequirements.budgetMax;
  if (Object.keys(leadUpdates).length) {
    await Lead.updateOne({ _id: lead._id }, { $set: leadUpdates });
  }

  // Small human-like "typing" pause before sending — kept tight at 3-4s
  // (randomized so every reply doesn't land at the exact same delay) rather
  // than the old 2/5/10s Settings dropdown, which could feel too slow.
  const replyDelayMs = 3000 + Math.floor(Math.random() * 1000); // 3000-4000ms
  await new Promise((resolve) => setTimeout(resolve, replyDelayMs));

  // Send the reply out through Unipile — into the existing chat if we have
  // its chat_id already, otherwise this starts one (shouldn't normally
  // happen here since an inbound message always carries a chat_id, but the
  // fallback keeps this robust either way).
  let outbound;
  try {
    const { chatId, messageId } = await unipileClient.sendToLead({
      existingChatId: conversation.unipileChatId,
      phone: lead.phone,
      text: parsed.reply,
    });
    if (chatId && conversation.unipileChatId !== chatId) conversation.unipileChatId = chatId;

    outbound = await recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: parsed.reply,
      sender: 'ai',
      whatsappMessageId: messageId || null,
      aiPrompt: systemInstruction,
      aiResponseRaw: raw,
      intent: parsed.intent,
      sentiment: parsed.sentiment,
    });
  } catch (err) {
    logger.error(`[ai] Failed to send AI reply for lead ${lead._id} via Unipile`, { error: err.message });
    await Notification.create({
      userId: conversation.ownerId,
      type: 'whatsapp_send_failed',
      title: `Couldn't message ${lead.name || 'lead'} — WhatsApp send failed`,
      body: `Sending via Unipile failed for ${lead.phone}: ${err.message}`,
      link: `/leads/${lead._id}`,
    });
    emitToUser(conversation.ownerId, 'notification:new', { leadId: lead._id });
    return;
  }

  // Buyer just agreed to a site visit — create it automatically.
  if (parsed.wantsSiteVisit) {
    await createSiteVisit({ lead, conversation, date: parsed.proposedDate, time: parsed.proposedTime, property: candidateProperties[0] });
  }

  conversation.requirementsComplete = !!parsed.readyForPropertyRecommendation;
  await conversation.save();

  emitToUser(conversation.ownerId, 'conversation:aiReply', {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  // Lead scoring + follow-up planning runs as a separate Gemini pass, fired
  // async so the buyer isn't kept waiting on a second model call.
  analyzeConversationAsync({ leadId: lead._id, conversationId: conversation._id }).catch((err) =>
    logger.error(`[ai] Async lead analysis failed for lead ${lead._id}`, { error: err.message })
  );
}

/**
 * Sends the very first outbound WhatsApp message to a freshly created lead —
 * this is what makes "as soon as a lead is added, start the conversation
 * automatically" actually happen.
 *
 * Idempotent/safe to call more than once for the same lead: no-ops if the
 * conversation already has any messages, isn't AI-driven, or AI is paused.
 * Unlike the old Baileys/QR setup there's no "is WhatsApp connected" gate —
 * Unipile's connection lives on their side, so as long as UNIPILE_API_KEY
 * and UNIPILE_ACCOUNT_ID are configured, sending just works.
 */
async function startConversation({ lead, conversation }) {
  if (conversation.status !== 'ai_active') return;

  const alreadyStarted = await Message.exists({ conversationId: conversation._id });
  if (alreadyStarted) return;

  if (!env.unipile.apiKey || !env.unipile.accountId) {
    logger.warn(
      `[ai] Unipile is not configured (UNIPILE_API_KEY/UNIPILE_ACCOUNT_ID) — skipping opening message for lead ${lead._id}`
    );
    return;
  }

  const settings = await settingsService.getOrCreateSettings();
  if (settings.aiPaused || !settings.autoReplyEnabled) return;
  if (settings.whatsappDisconnected) return;

  const apiKey = await settingsService.getGeminiKey();

  const systemInstruction = buildSystemInstruction({
    lead,
    settings,
    collectedRequirements: {},
    matchedProperties: [],
  });

  // Deterministic fallback if there's no Gemini key configured yet, or the
  // AI call fails — the buyer still gets a first message either way.
  let replyText =
    settings.greetingMessage ||
    `Hi ${lead.name || 'there'}! Thanks for your interest — I'd love to help you find the right property. What are you looking for?`;
  let raw = null;
  let usedAi = false;

  if (apiKey) {
    try {

      const result = await generateStructured({
        apiKey,
        systemInstruction,
        history: buildOpeningHistory(), // Gemini requires non-empty contents — no real turns exist yet
        responseSchema: REPLY_RESPONSE_SCHEMA,
      });
      replyText = result.parsed.reply;
      raw = result.raw;
      usedAi = true;
    } catch (err) {
      logger.error(
        `[ai] Failed to generate AI opening message for lead ${lead._id} — falling back to the default greeting`,
        { error: err.message }
      );
    }
  }

  let outbound;
  try {
    const { chatId, messageId } = await unipileClient.sendToLead({
      existingChatId: conversation.unipileChatId,
      phone: lead.phone,
      text: replyText,
    });
    if (chatId) conversation.unipileChatId = chatId;

    outbound = await recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: replyText,
      sender: 'ai',
      whatsappMessageId: messageId || null,
      aiPrompt: usedAi ? systemInstruction : null,
      aiResponseRaw: raw,
    });
  } catch (err) {
    logger.error(`[ai] Failed to send opening WhatsApp message for lead ${lead._id} via Unipile`, { error: err.message });
    await Notification.create({
      userId: conversation.ownerId,
      type: 'whatsapp_send_failed',
      title: `Couldn't message ${lead.name || 'lead'} — WhatsApp send failed`,
      body: `Sending via Unipile failed for ${lead.phone}: ${err.message}`,
      link: `/leads/${lead._id}`,
    });
    emitToUser(conversation.ownerId, 'notification:new', { leadId: lead._id });
    return;
  }

  conversation.lastMessageAt = new Date();
  await conversation.save();

  emitToUser(conversation.ownerId, 'conversation:aiReply', {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });
}

/**
 * Finds any of a broker's leads whose conversation is still ai_active with
 * zero messages (e.g. their opening message failed earlier — Unipile down,
 * misconfigured API key, etc) and retries starting them now. Not wired to
 * any automatic trigger since Unipile has no "connect" event to hook into
 * the way the old Baileys session did — call this manually (e.g. from an
 * admin action or a cron job) if you want a retry sweep.
 */
async function catchUpPendingConversations(brokerId) {
  const pending = await Conversation.find({ ownerId: brokerId, status: 'ai_active' }).lean();
  if (!pending.length) return;

  const leadIds = pending.map((c) => c.leadId);
  const leads = await Lead.find({ _id: { $in: leadIds } }).lean();
  const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

  let started = 0;
  for (const convoLean of pending) {
    const hasMessage = await Message.exists({ conversationId: convoLean._id });
    if (hasMessage) continue;

    const lead = leadById.get(convoLean.leadId.toString());
    if (!lead) continue;

    // Need a hydrated (non-lean) document since startConversation calls .save() on it.
    const conversation = await Conversation.findById(convoLean._id);
    started += 1;
    startConversation({ lead, conversation }).catch((err) =>
      logger.error(`[ai] Catch-up auto-start failed for lead ${lead._id}`, { error: err.message })
    );
  }

  if (started) {
    logger.info(`[ai] Broker ${brokerId} connected — auto-starting ${started} pending WhatsApp conversation(s)`);
  }
}

function mergeRequirements(existing, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Creates a Meeting the first time a buyer agrees to a site visit for this
 * lead, and simply UPDATES that same Meeting on every later turn instead of
 * inserting a new one — e.g. if the AI re-confirms the date/time again a
 * few messages later, or the buyer changes the time mid-conversation. Only
 * an already-finished meeting (visited / not_visited / cancelled) is left
 * alone and a fresh one started, since that's a genuinely new visit.
 */
async function createSiteVisit({ lead, conversation, date, time, property }) {
  const preferredDate = date || new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10); // default: 2 days out if not specified yet
  const preferredTime = time || '11:00';

  let meeting = await Meeting.findOne({
    leadId: lead._id,
    status: { $in: ['scheduled', 'rescheduled'] },
  }).sort({ createdAt: -1 });

  let isNew = false;
  if (meeting) {
    meeting.preferredDate = preferredDate;
    meeting.preferredTime = preferredTime;
    if (property?._id) meeting.propertyId = property._id;
    meeting.status = 'scheduled';
    await meeting.save();
  } else {
    isNew = true;
    meeting = await Meeting.create({
      leadId: lead._id,
      ownerId: conversation.ownerId,
      propertyId: property?._id || null,
      preferredDate,
      preferredTime,
      status: 'scheduled',
    });
  }

  // Cached copy on Conversation for quick UI reads — Meeting model remains
  // the source of truth. Keep this in sync any time Meeting.status changes
  // elsewhere too (e.g. a broker marking a visit as done/cancelled).
  conversation.meetingStatus = 'scheduled';
  await Lead.updateOne({ _id: lead._id }, { $set: { status: 'site_visit' } });

  // Book/update the real calendar event. Best-effort: a Calendar failure
  // must never block the WhatsApp conversation or lose the Meeting record.
  try {
    if (meeting.googleEventId) {
      const event = await updateCalendarEvent({ eventId: meeting.googleEventId, date: preferredDate, time: preferredTime });
      if (event) {
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    } else {
      const event = await createCalendarEvent({
        summary: `Site Visit — ${lead.name || lead.phone}${property ? ` (${property.projectName})` : ''}`,
        description: [
          `Lead: ${lead.name || 'N/A'} (${lead.phone})`,
          property ? `Property: ${property.projectName}, ${property.city || ''}` : null,
          'Booked automatically by the AI WhatsApp assistant.',
        ]
          .filter(Boolean)
          .join('\n'),
        date: preferredDate,
        time: preferredTime,
      });
      if (event) {
        meeting.googleEventId = event.eventId;
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    }
  } catch (err) {
    logger.error(`[calendar] Failed to sync Google Calendar event for lead ${lead._id}`, { error: err.message });
  }

  if (isNew) {
    await Notification.create({
      userId: conversation.ownerId,
      type: 'site_visit_scheduled',
      title: `Site visit scheduled — ${lead.name}`,
      body: `${preferredDate} at ${preferredTime}${property ? ` for ${property.projectName}` : ''}`,
      link: `/leads/${lead._id}`,
    });
  }

  emitToUser(conversation.ownerId, 'meeting:created', { meeting });

  return meeting;
}

module.exports = { handleInbound, createSiteVisit, startConversation, catchUpPendingConversations };