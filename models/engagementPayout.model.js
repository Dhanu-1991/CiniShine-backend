import mongoose from 'mongoose';

const engagementPayoutSchema = new mongoose.Schema({
  payoutMonth: {
    type: String,
    required: true,
    index: true, // not unique — multiple runs per month allowed
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
  totalContentSkipped: {
    type: Number,
    default: 0,
  },
  totalContentFailed: {
    type: Number,
    default: 0,
  },
  minViewsThreshold: {
    type: Number,
    default: 10,
  },
  scoreWeights: {
    watchPercent: { type: Number, default: 0.30 },
    completion: { type: Number, default: 0.25 },
    likes: { type: Number, default: 0.15 },
    comments: { type: Number, default: 0.10 },
    shares: { type: Number, default: 0.10 },
    duration: { type: Number, default: 0.10 },
  },
  baseCpmUsed: {
    type: Number,
    default: 200,
  },
  growthFactorEnabled: {
    type: Boolean,
    default: true,
  },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed', 'partial'],
    default: 'processing',
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
    growthFactor: Number,
    payoutAmount: Number,
    deltaViews: Number,
    metrics: {
      views: Number,
      deltaViews: Number,
      previousPaidViews: Number,
      totalWatchTime: Number,
      avgWatchPercent: Number,
      completionRate: Number,
      duration: Number,
      likes: Number,
      dislikes: Number,
      shares: Number,
      comments: Number,
    }
  }],
  skippedContents: [{
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
    contentTitle: String,
    contentType: String,
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    creatorName: String,
    reason: String,
    views: Number,
  }],
  failedContents: [{
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
    contentTitle: String,
    contentType: String,
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    creatorName: String,
    error: String,
  }],
  periodStart: Date,
  periodEnd: Date,
  createdAt: { type: Date, default: Date.now }
});

// Compound index for efficient lookups
engagementPayoutSchema.index({ payoutMonth: 1, createdAt: -1 });
engagementPayoutSchema.index({ status: 1 });

const EngagementPayout = mongoose.models.EngagementPayout || mongoose.model('EngagementPayout', engagementPayoutSchema);
export default EngagementPayout;
