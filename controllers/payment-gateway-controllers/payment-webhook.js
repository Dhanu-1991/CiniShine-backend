import crypto from "crypto";
import dotenv from "dotenv";
import PaymentDetails from "../../models/payment.details.model.js";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

dotenv.config();

/** Platform cut percentage for PPV purchases via gateway */
const PLATFORM_CUT_PERCENT = 30;

// Helper: flatten nested objects for pre-2025-01-01 versions
const flattenObject = (obj, parentKey = "", result = {}) => {
  for (const key in obj) {
    const propName = parentKey ? `${parentKey}.${key}` : key;
    if (obj[key] !== null && typeof obj[key] === "object") {
      flattenObject(obj[key], propName, result);
    } else {
      result[propName] = obj[key];
    }
  }
  return result;
};

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature =
      req.headers["x-webhook-signature"] || req.headers["x-cf-signature"];
    const version = req.headers["x-webhook-version"] || "";

    if (!receivedSignature || !secret) {
      console.warn("Webhook missing signature or secret");
      // Cashfree's "Test Endpoint" button does not send a signature.
      // We return 200 so the dashboard test passes, but we do not process the payload.
      return res.status(200).send("Webhook received but signature missing (Test Mode)");
    }

    // Raw payload buffer → string (exact bytes)
    const rawBodyString = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

    let dataToSign;
    if (version === "2025-01-01") {
      dataToSign = rawBodyString;
    } else {
      const payload = JSON.parse(rawBodyString);
      const flat = flattenObject(payload);
      const sortedKeys = Object.keys(flat).sort();
      dataToSign = sortedKeys.reduce((acc, key) => {
        const v = flat[key];
        return v != null ? acc + String(v) : acc;
      }, "");
    }

    const generatedSignature = crypto
      .createHmac("sha256", secret)
      .update(dataToSign)
      .digest("base64");

    if (generatedSignature !== receivedSignature) {
      console.error("Signature mismatch", {
        generated: generatedSignature,
        received: receivedSignature,
        version,
      });
      return res.status(400).send("Invalid signature");
    }

    console.log("✅ Webhook verified (v" + version + ")");

    const payload = JSON.parse(rawBodyString);
    
    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const { order, payment } = payload.data || {};
      const orderId = order?.order_id;
      const paymentId = payment?.cf_payment_id || payment?.payment_id;
      const amount = payment?.payment_amount;
      const currency = payment?.payment_currency || "INR";
      
      console.log(`Processing success for Order: ${orderId}`);
      
      const contentId = order?.order_tags?.contentId || order?.order_meta?.contentId;
      const userId = order?.order_tags?.userId || order?.order_meta?.userId;
      
      const type = order?.order_tags?.type || "ppv_purchase";
      const existingPayment = await PaymentDetails.findOne({ orderId });
      if (!existingPayment || existingPayment.status === "PENDING") {
        if (type === "wallet_recharge") {
          // --- WALLET RECHARGE LOGIC ---
          await fulfillWalletRecharge({
            orderId,
            paymentId,
            amount,
            currency,
            userId
          });
        } else {
          // --- PPV PURCHASE LOGIC ---
          await fulfillPpvPurchase({
            orderId,
            paymentId,
            amount,
            currency,
            userId,
            contentId
          });
        }
      } else {
        console.log(`Order ${orderId} already processed.`);
      }
    } else if (payload.type === "PAYMENT_FAILED_WEBHOOK") {
      const { order, payment } = payload.data || {};
      const orderId = order?.order_id;
      const paymentId = payment?.cf_payment_id || payment?.payment_id;
      const amount = payment?.payment_amount;
      const currency = payment?.payment_currency || "INR";
      
      const contentId = order?.order_tags?.contentId || order?.order_meta?.contentId;
      const userId = order?.order_tags?.userId || order?.order_meta?.userId;
      
      const existingPayment = await PaymentDetails.findOne({ orderId });
      if (!existingPayment) {
        await PaymentDetails.create({
          orderId,
          paymentId,
          amount,
          currency,
          status: "FAILED",
          userId,
          contentId
        });
        console.log(`Payment failure recorded for Order: ${orderId}`);
      }
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).send("Internal Server Error");
  }
};
