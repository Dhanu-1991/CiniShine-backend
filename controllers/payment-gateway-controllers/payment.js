// backend/controllers/payment-gateway-controllers/payment.js
import dotenv from "dotenv";
dotenv.config();

import { Cashfree, CFEnvironment } from "cashfree-pg";
import generateOrderId from "./get.order.id.js";
import User from "../../models/user.model.js";
import PaymentDetails from "../../models/payment.details.model.js";

// ✅ Correct instantiation for SDK v5.0.8
const cfEnv = process.env.CASHFREE_MODE?.trim() === 'production' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
const cashfree = new Cashfree(cfEnv, process.env.CF_CLIENT_ID?.trim(), process.env.CF_CLIENT_SECRET?.trim());

const payment = async (req, res) => {
  try {
    const { price, contentId } = req.body;
    console.log("Received price:", price, "ContentId:", contentId);
    
    if (!contentId) {
      return res.status(400).json({ error: "contentId is required" });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    console.log("Calling generateOrderId function");
    const orderId = await generateOrderId();
    console.log("Generated order ID:", orderId);

    const request = {
      order_id: orderId,
      order_amount: price,
      order_currency: "INR",
      customer_details: {
        customer_id: user._id.toString(),
        customer_email: user.email || "user@example.com",
        customer_phone: user.phone || "9876543210"
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/result?order_id=${orderId}`,
        payment_methods: ""
      },
      order_tags: {
        contentId: contentId.toString(),
        userId: user._id.toString()
      }
    };

    // Create a pending record in DB so payment-verify never sees null
    await PaymentDetails.create({
      orderId,
      paymentId: "PENDING_GENERATION",
      status: "PENDING",
      amount: price,
      currency: "INR",
      userId: user._id,
      contentId: contentId
    });

    const response = await cashfree.PGCreateOrder(request);
    console.log("Payment session created successfully:", response.data);

    res.status(200).json({
      order_id: orderId,
      payment_session_id: response.data.payment_session_id, // ✅ required by SDK
      contentId
    });

  } catch (error) {
    console.error("Payment initiation error:", error?.response?.data || error.message);
    const cfError = error?.response?.data?.message || error?.message || 'Unknown error';
    res.status(500).json({ error: `Failed to create payment session: ${cfError}` });
  }
};

export default payment;
