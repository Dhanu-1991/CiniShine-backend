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
    default: 0.25,
  },
  status: {
    type: String,
    enum: ['completed', 'failed'],
    default: 'completed',
  },
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
    engagementScore: Number,
    engagementMultiplier: Number,
    payoutAmount: Number,
    metrics: {
      views: Number,
      totalWatchTime: Number,
      avgWatchPercent: Number,
      completionRate: Number,
      likes: Number,
      dislikes: Number,
      shares: Number,
      comments: Number
    }
  }],
  periodStart: Date,
  periodEnd: Date,
  createdAt: { type: Date, default: Date.now }
});

const EngagementPayout = mongoose.models.EngagementPayout || mongoose.model('EngagementPayout', engagementPayoutSchema);
export default EngagementPayout;
