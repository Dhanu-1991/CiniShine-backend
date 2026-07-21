import dotenv from "dotenv";
dotenv.config();

import Razorpay from "razorpay";
import generateOrderId from "./get.order.id.js";
import User from "../../models/user.model.js";
import PaymentDetails from "../../models/payment.details.model.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "default_key_id",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "default_key_secret",
});

const payment = async (req, res) => {
  try {
    const { price, contentId } = req.body;
    
    // For wallet recharge, contentId might be 'recharge' or null, depending on logic.
    // If we require it, make sure frontend passes it.
    if (!contentId) {
      return res.status(400).json({ error: "contentId is required" });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const orderId = await generateOrderId();

    const options = {
      amount: Math.round(price * 100), // Razorpay amount is in paise
      currency: "INR",
      receipt: orderId,
      notes: {
        contentId: contentId.toString(),
        userId: user._id.toString()
      }
    };

    const order = await razorpay.orders.create(options);

    await PaymentDetails.create({
      orderId: order.id, 
      paymentId: "PENDING_GENERATION",
      status: "PENDING",
      amount: price,
      currency: "INR",
      userId: user._id,
      contentId: contentId === "recharge" ? null : contentId 
    });

    res.json({
      gateway: "razorpay",
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      customer_name: user.userName || user.channelName || "User",
      customer_email: user.email || "user@example.com",
      customer_phone: user.phone || "9876543210"
    });
  } catch (error) {
    console.error("Razorpay initiation error:", error);
    res.status(500).json({ error: "Failed to initiate Razorpay payment", details: error.message });
  }
};

export default payment;
