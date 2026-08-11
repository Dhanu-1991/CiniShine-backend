import mongoose from 'mongoose';

const engagementPayoutSchema = new mongoose.Schema({
  payoutMonth: {
    type: String,
    required: true,
    unique: true, // '2026-08' format
  },
  totalPool: {
    type: Number,
    default: 0,
  },
  totalContentEvaluated: {
    type: Number,
    default: 0,
  },
  totalCreatorsPaid: {
    type: Number,
    default: 0,
  },
  totalContentPaid: {
    type: Number,
    default: 0,
  },
  minViewsThreshold: {
    type: Number,
    default: 10,
  },
  scoreWeights: {
    views: { type: Number, default: 0.25 },
    watchtime: { type: Number, default: 0.30 },
    completion: { type: Number, default: 0.20 },
    likes: { type: Number, default: 0.10 },
    shares: { type: Number, default: 0.10 },
    comments: { type: Number, default: 0.05 }
  },
  baseCpm: {
    type: Number,
    default: 0.13, // ₹0.13/view = ₹130/1K views floor
  },
  maxCpm: {
    type: Number,
    default: 0.175, // ₹0.175/view = ₹175/1K views ceiling
  },
  status: {
    type: String,
    enum: ['completed', 'failed', 'partial'],
    default: 'completed',
  },
  skippedPayouts: [{
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
    contentTitle: String,
    reason: String,
  }],
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  contentPayouts: [{
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
    contentTitle: String,
    contentType: String,
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    creatorName: String,
    engagementScore: Number,   // 0-100 EQS score
    engagementMultiplier: Number, // e.g. 1.0x – 1.35x
    payoutAmount: Number,
    metrics: {
      views: Number,
      newViews: Number,
      paidViews: Number,
      totalWatchTime: Number,
      avgWatchPercent: Number,
      completionRate: Number,
      likes: Number,
      dislikes: Number,
      shares: Number,
      comments: Number,
      duration: Number,
    }
  }],
  periodStart: Date,
  periodEnd: Date,
  createdAt: { type: Date, default: Date.now }
});

const EngagementPayout = mongoose.models.EngagementPayout || mongoose.model('EngagementPayout', engagementPayoutSchema);
export default EngagementPayout;
