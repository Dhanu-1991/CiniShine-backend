import mongoose from 'mongoose';

const purchaseSchema = new mongoose.Schema({
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, default: null },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  purchasedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'active', 'expired', 'refunded'], default: 'pending' }
});

purchaseSchema.index({ buyerId: 1, contentId: 1, expiresAt: 1 });
purchaseSchema.index({ contentId: 1 });
purchaseSchema.index({ expiresAt: 1 });

const Purchase = mongoose.model('Purchase', purchaseSchema);
export default Purchase;
