import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import PaymentDetails from "../../models/payment.details.model.js";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

const razorpayVerify = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    // ─── STATUS-CHECK MODE ─────────────────────────────────────────────────────
    // Called from PaymentResultPage after redirect (just orderId, no signature).
    // The Razorpay modal handler already verified + fulfilled before redirecting.
    // We only need to read the DB record and return its current status.
    if (orderId && !razorpay_signature) {
      console.log("Razorpay status check for orderId:", orderId);
      const paymentDetail = await PaymentDetails.findOne({ orderId });
      if (!paymentDetail) {
        // Could be a Cashfree order being checked while gateway is Razorpay.
        // Return NOT_FOUND with a neutral message — PaymentResultPage will retry.
        return res.status(200).json({ order_status: "UNKNOWN", paymentDetails: null });
      }
      return res.status(200).json({
        order_status: paymentDetail.status,
        paymentDetails: paymentDetail,
      });
    }

    // ─── FULL SIGNATURE VERIFY MODE ────────────────────────────────────────────
    // Called from Razorpay modal handler with signature tokens.
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
      console.error("Razorpay signature mismatch for order:", razorpay_order_id);
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Signature valid — find pending record
    let paymentDetail = await PaymentDetails.findOne({ orderId: razorpay_order_id });

    if (!paymentDetail) {
      return res.status(404).json({ error: "Order not found in database" });
    }

    if (paymentDetail.status === "SUCCESS") {
      // Already fulfilled (webhook fired before this call)
      return res.json([{
        orderId: paymentDetail.orderId,
        status: paymentDetail.status,
        message: "Payment already verified and fulfilled.",
      }]);
    }

    // Fulfill based on content type
    const amount = paymentDetail.amount;
    const currency = paymentDetail.currency;
    const userId = paymentDetail.userId;
    const contentId = paymentDetail.contentId;

    if (!contentId) {
      // Wallet Recharge
      console.log(`Razorpay: fulfilling wallet recharge for order ${razorpay_order_id}`);
      paymentDetail = await fulfillWalletRecharge({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId,
      });
    } else {
      // PPV Purchase
      console.log(`Razorpay: fulfilling PPV purchase for order ${razorpay_order_id}`);
      paymentDetail = await fulfillPpvPurchase({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId,
        contentId,
      });
    }

    return res.json([{
      orderId: paymentDetail.orderId,
      status: paymentDetail.status,
      message: "Payment successfully verified and fulfilled.",
    }]);

  } catch (error) {
    console.error("Razorpay verification error:", error);
    res.status(500).json({ error: "Failed to verify Razorpay payment", details: error.message });
  }
};

export default razorpayVerify;
