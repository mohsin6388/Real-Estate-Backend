// const mongoose = require('mongoose');
// const { Schema } = mongoose;

// const conversationSchema = new Schema(
//   {
//     leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, unique: true },
//     ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

   
//     unipileChatId: { type: String, default: null, index: true },

//     status: {
//       type: String,
//       enum: ['ai_active', 'manual', 'paused', 'closed'],
//       default: 'ai_active',
//     },

//     lastMessageAt: { type: Date, default: null },
//     unreadCount: { type: Number, default: 0 },

//     aiSummary: { type: String, default: '' },
//     currentLeadScore: { type: Number, default: 0 },

//     collectedRequirements: { type: Schema.Types.Mixed, default: {} },
//     requirementsComplete: { type: Boolean, default: false },

//     lastIntent: { type: String, default: null },
//     lastSentiment: { type: String, default: null },

//     recommendedProperties: [{ type: Schema.Types.ObjectId, ref: 'Property' }],
//     meetingStatus: {
//       type: String,
//       enum: ['none', 'proposed', 'scheduled', 'visited', 'not_visited', 'cancelled'],
//       default: 'none',
//     },

//     tags: [{ type: String, trim: true }],
//   },
//   { timestamps: true }
// );

// conversationSchema.index({ ownerId: 1, status: 1, lastMessageAt: -1 });

// module.exports = mongoose.model('Conversation', conversationSchema);



const mongoose = require('mongoose');
const { Schema } = mongoose;

const conversationSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    unipileChatId: {
      type: String,
      default: null,
      index: true,
      unique: true,
      sparse: true, // multiple nulls allowed, but non-null values must be unique
    },

    status: {
      type: String,
      enum: ['ai_active', 'manual', 'paused', 'closed'],
      default: 'ai_active',
    },

    lastMessageAt: { type: Date, default: null, index: true },
    unreadCount: { type: Number, default: 0 },

    aiSummary: { type: String, default: '' },
    currentLeadScore: { type: Number, default: 0 },

    collectedRequirements: {
      budgetMin: { type: Number, default: null },
      budgetMax: { type: Number, default: null },
      city: { type: String, default: null },
      bhk: { type: String, default: null },
      propertyType: { type: String, default: null },
      extra: { type: Schema.Types.Mixed, default: {} }, // AI ke naye/unstructured fields yahin
    },
    requirementsComplete: { type: Boolean, default: false },

    lastIntent: { type: String, default: null },
    lastSentiment: { type: String, default: null },

    recommendedProperties: [{ type: Schema.Types.ObjectId, ref: 'Property' }],

    meetingStatus: {
      type: String,
      enum: ['none', 'proposed', 'scheduled', 'visited', 'not_visited', 'cancelled'],
      default: 'none',
    },

    tags: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

conversationSchema.index({ ownerId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);