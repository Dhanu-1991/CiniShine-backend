import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import PaymentDetails from "../../models/payment.details.model.js";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

const razorpayVerify = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    console.log("Razorpay verify called with orderId:", razorpay_order_id);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required Razorpay parameters" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");
      
    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Signature is valid. Find pending payment.
    let paymentDetail = await PaymentDetails.findOne({ orderId: razorpay_order_id });
    
    if (!paymentDetail) {
      return res.status(404).json({ error: "Order not found in database" });
    }

    if (paymentDetail.status === "SUCCESS") {
      // Already fulfilled via webhook or earlier verification
      return res.json([{ 
        orderId: paymentDetail.orderId, 
        status: paymentDetail.status, 
        message: "Payment successfully verified." 
      }]);
    }

    // Fulfill order
    const amount = paymentDetail.amount;
    const currency = paymentDetail.currency;
    const userId = paymentDetail.userId;
    const contentId = paymentDetail.contentId;

    if (!contentId) {
      // Wallet Recharge
      paymentDetail = await fulfillWalletRecharge({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId
      });
    } else {
      // PPV Purchase
      paymentDetail = await fulfillPpvPurchase({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId,
        contentId
      });
    }

    return res.json([{ 
      orderId: paymentDetail.orderId, 
      status: paymentDetail.status, 
      message: "Payment successfully verified." 
    }]);

  } catch (error) {
    console.error("Razorpay verification error:", error);
    res.status(500).json({ error: "Failed to verify Razorpay payment", details: error.message });
  }
};

export default razorpayVerify;
