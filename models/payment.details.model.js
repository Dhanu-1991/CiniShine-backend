import mongoose from "mongoose";

const paymentDetailsSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, required: true },
  status: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
}, { timestamps: true });

const PaymentDetails = mongoose.model("PaymentDetails", paymentDetailsSchema);
export default PaymentDetails;
