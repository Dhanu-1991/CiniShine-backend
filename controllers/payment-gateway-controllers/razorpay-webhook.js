import crypto from "crypto";
import PaymentDetails from "../../models/payment.details.model.js";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

export const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers["x-razorpay-signature"];

    if (!webhookSecret) {
      console.error("Razorpay webhook secret not configured");
      return res.status(500).send("Webhook secret missing");
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (expectedSignature !== signature) {
      console.error("Invalid Razorpay webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === "payment.captured") {
      const paymentEntity = payload.payment.entity;
      const razorpay_order_id = paymentEntity.order_id;
      const razorpay_payment_id = paymentEntity.id;
      const amount = paymentEntity.amount / 100; // convert paise to rupees
      const currency = paymentEntity.currency;
      
      // We can also fetch the notes to get contentId and userId if we didn't rely on DB state.
      // But we will use the existing DB record created during initiation.
      let paymentDetail = await PaymentDetails.findOne({ orderId: razorpay_order_id });
      
      if (!paymentDetail) {
        console.error(`Razorpay webhook: Order ${razorpay_order_id} not found in DB.`);
        return res.status(404).send("Order not found");
      }

      if (paymentDetail.status === "SUCCESS") {
        return res.status(200).send("Already processed");
      }

      const userId = paymentDetail.userId;
      const contentId = paymentDetail.contentId;

      if (!contentId) {
        await fulfillWalletRecharge({
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          amount,
          currency,
          userId
        });
      } else {
        await fulfillPpvPurchase({
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          amount,
          currency,
          userId,
          contentId
        });
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payment.entity;
      const razorpay_order_id = paymentEntity.order_id;
      
      await PaymentDetails.findOneAndUpdate(
        { orderId: razorpay_order_id },
        { status: "FAILED" }
      );
    }

    res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    res.status(500).send("Internal Server Error");
  }
};
