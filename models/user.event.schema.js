import mongoose from "mongoose";

const UserEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  eventType: String, // view, like, dislike, share, impression, watch_progress
  eventValue: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});
UserEventSchema.index({ contentId: 1, createdAt: -1 });

const UserEvent = mongoose.model("UserEvent", UserEventSchema);
export default UserEvent;