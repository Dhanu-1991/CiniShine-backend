import mongoose from "mongoose";

const paymentDetailsSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  paymentId: { type: String, required: true },
  status: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const PaymentDetails = mongoose.model("PaymentDetails", paymentDetailsSchema);
export default PaymentDetails;
