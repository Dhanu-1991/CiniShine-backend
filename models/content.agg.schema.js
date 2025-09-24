import mongoose from "mongoose";

const ContentAggSchema = new mongoose.Schema({
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', unique: true },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  shares: { type: Number, default: 0 },
  watchFractionSum: { type: Number, default: 0 }, // sum(watched_seconds/duration)
  watchFractionCount: { type: Number, default: 0 }, // count of views used
  lastViewedAt: Date,
  // you can add computed fields like avg_watch_fraction, views_24h etc.
});

const ContentAgg = mongoose.model("ContentAgg", ContentAggSchema);
export default ContentAgg;