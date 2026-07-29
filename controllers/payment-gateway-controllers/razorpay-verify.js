import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import PaymentDetails from "../../models/payment.details.model.js";

/**
 * Razorpay Verify — STATUS-CHECK & SIGNATURE ACKNOWLEDGMENT ONLY.
 *
 * This endpoint does NOT fulfill orders (no wallet credit, no purchase creation).
 * Fulfillment happens exclusively via the Razorpay webhook (razorpay-webhook.js).
 *
 * Two modes:
 *  1. Status-check: frontend polls with { orderId } to check if webhook has fulfilled.
 *  2. Signature ack: frontend sends { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *     after checkout popup closes → we verify signature, record paymentId, mark PAYMENT_RECEIVED.
 */
const razorpayVerify = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    // ─── MODE 1: STATUS-CHECK (polling from PaymentResultPage) ─────────────────
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

    // ─── MODE 2: SIGNATURE ACKNOWLEDGMENT (from Razorpay checkout handler) ─────
    console.log(`\n=================== [RAZORPAY_VERIFY_ACK] ===================`);
    console.log(`Razorpay OrderID: ${razorpay_order_id} | PaymentID: ${razorpay_payment_id}`);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.error(`[RAZORPAY_VERIFY] Missing required parameters`);
      return res.status(400).json({ error: "Missing required Razorpay parameters" });
    }

    // Verify the Razorpay payment signature to confirm the checkout was legitimate
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

    // Find the pending payment record
    const paymentDetail = await PaymentDetails.findOne({ orderId: razorpay_order_id });

    if (!paymentDetail) {
      console.error(`❌ [RAZORPAY_VERIFY] Order ${razorpay_order_id} not found in DB`);
      return res.status(404).json({ error: "Order not found in database" });
    }

    // If webhook already fulfilled it, just return success
    if (paymentDetail.status === "SUCCESS") {
      console.log(`[RAZORPAY_VERIFY] [ALREADY_FULFILLED] Order ${razorpay_order_id} already completed by webhook.`);
      return res.json([{
        orderId: paymentDetail.orderId,
        status: paymentDetail.status,
        message: "Payment already verified and fulfilled.",
      }]);
    }

    // Record the paymentId and mark as PAYMENT_RECEIVED (awaiting webhook fulfillment)
    // This does NOT credit wallets or create purchases — the webhook does that.
    paymentDetail.paymentId = razorpay_payment_id;
    paymentDetail.status = "PAYMENT_RECEIVED";
    await paymentDetail.save();

    console.log(`[RAZORPAY_VERIFY] Marked order ${razorpay_order_id} as PAYMENT_RECEIVED. Awaiting webhook fulfillment.`);
    console.log(`=================== [RAZORPAY_VERIFY_ACK_DONE] ===================\n`);

    return res.json([{
      orderId: paymentDetail.orderId,
      status: "PAYMENT_RECEIVED",
      message: "Payment received. Confirming via payment provider...",
    }]);

  } catch (error) {
    console.error("❌ [RAZORPAY_VERIFY_ERROR]", error);
    res.status(500).json({ error: "Failed to verify Razorpay payment", details: error.message });
  }
};

export default razorpayVerify;
