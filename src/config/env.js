require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/real_estate_crm'),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev_access_secret_change_me'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  resetTokenExpiresMin: parseInt(process.env.RESET_TOKEN_EXPIRES_MIN || '30', 10),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'AI Real Estate CRM <no-reply@example.com>',
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev_encryption_key_change_me_in_prod',

  // Unipile — cloud WhatsApp API, replaces the old local Baileys/QR session.
  unipile: {
    apiKey: process.env.UNIPILE_API_KEY || null,
    // e.g. https://api51.unipile.com:18127 (no trailing slash)
    dsn: (process.env.UNIPILE_DSN || 'https://api51.unipile.com:18127').replace(/\/+$/, ''),
    accountId: process.env.UNIPILE_ACCOUNT_ID || null,
    // Optional shared secret appended as ?secret=... to the webhook URL you
    // register in the Unipile dashboard, so random internet POSTs can't feed
    // fake "messages" into the AI engine.
    webhookSecret: process.env.UNIPILE_WEBHOOK_SECRET || null,
  },

  // Inbound WhatsApp messages from numbers that don't match any existing
  // Lead (i.e. someone messaged the connected WhatsApp number first, before
  // ever being imported/added as a lead) get auto-created as a new Lead so
  // the AI can respond to them too. This is the broker/user account that
  // "owns" the single connected WhatsApp number for this deployment — set
  // it to that broker's User._id. If left unset, the app falls back to the
  // first admin/broker user it finds (logged once at startup-time use).
  leads: {
    defaultOwnerId: process.env.DEFAULT_LEAD_OWNER_ID || null,
  },

  // Google Calendar — used to create the actual calendar event once the AI
  // confirms a site visit with a lead. Auth is via a Service Account (no
  // per-user OAuth dance needed): share the target calendar with the
  // service account's email as "Make changes to events".
  googleCalendar: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || null,
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n') || null,
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    timezone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'Asia/Kolkata',
    defaultDurationMin: parseInt(process.env.GOOGLE_CALENDAR_EVENT_DURATION_MIN || '45', 10),
  },

  rateLimit: {
    windowMin: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '15', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  },
};

module.exports = env;
