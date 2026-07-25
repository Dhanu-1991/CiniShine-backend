import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import PaymentDetails from "../../models/payment.details.model.js";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

const razorpayVerify = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    // ─── STATUS-CHECK MODE ─────────────────────────────────────────────────────
    if (orderId && !razorpay_signature) {
      console.log(`[RAZORPAY_STATUS_CHECK] OrderID: ${orderId}`);
      const paymentDetail = await PaymentDetails.findOne({ orderId });
      if (!paymentDetail) {
        return res.status(200).json({ order_status: "UNKNOWN", paymentDetails: null });
      }
      return res.status(200).json({
        order_status: paymentDetail.status,
        paymentDetails: paymentDetail,
      });
    }

    // ─── FULL SIGNATURE VERIFY MODE ────────────────────────────────────────────
    console.log(`\n=================== [RAZORPAY_VERIFY_INIT] ===================`);
    console.log(`Razorpay OrderID: ${razorpay_order_id} | PaymentID: ${razorpay_payment_id}`);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.error(`[RAZORPAY_VERIFY] Missing required parameters`);
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
      console.error(`❌ [RAZORPAY_VERIFY] Signature mismatch for order: ${razorpay_order_id}`);
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    console.log(`✅ [RAZORPAY_VERIFY] Signature authentic for order: ${razorpay_order_id}`);

    // Signature valid — find pending record
    let paymentDetail = await PaymentDetails.findOne({ orderId: razorpay_order_id });

    if (!paymentDetail) {
      console.error(`❌ [RAZORPAY_VERIFY] Order ${razorpay_order_id} not found in DB`);
      return res.status(404).json({ error: "Order not found in database" });
    }

    if (paymentDetail.status === "SUCCESS") {
      console.log(`[RAZORPAY_VERIFY] [IDEMPOTENT_SKIP] Order ${razorpay_order_id} already fulfilled.`);
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
      console.log(`[RAZORPAY_VERIFY] Fulfilling wallet recharge for Order: ${razorpay_order_id}`);
      paymentDetail = await fulfillWalletRecharge({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId,
      });
    } else {
      // PPV Purchase
      console.log(`[RAZORPAY_VERIFY] Fulfilling PPV purchase for Order: ${razorpay_order_id}`);
      paymentDetail = await fulfillPpvPurchase({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount,
        currency,
        userId,
        contentId,
      });
    }

    console.log(`=================== [RAZORPAY_VERIFY_SUCCESS] ===================\n`);
    return res.json([{
      orderId: paymentDetail.orderId,
      status: paymentDetail.status,
      message: "Payment successfully verified and fulfilled.",
    }]);

  } catch (error) {
    console.error("❌ [RAZORPAY_VERIFY_ERROR]", error);
    res.status(500).json({ error: "Failed to verify Razorpay payment", details: error.message });
  }
};

export default razorpayVerify;
