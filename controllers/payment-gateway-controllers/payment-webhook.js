// controllers/payment-gateway-controllers/payment-webhook.js
import crypto from "crypto";
import dotenv from "dotenv";
import PaymentDetails from "../../models/payment.details.model.js";

dotenv.config();

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
      return res.status(400).send("Invalid signature or secret");
    }

    // Raw payload buffer → string (exact bytes)
    const rawBodyString = req.rawBody.toString("utf8");

    let dataToSign;
    if (version === "2025-01-01") {
      // 📣 v2025-01-01: sign the RAW JSON string directly
      dataToSign = rawBodyString;
    } else {
      // 📣 Older versions: parse, flatten, sort values, concat
      const payload = JSON.parse(rawBodyString);
      const flat = flattenObject(payload);
      const sortedKeys = Object.keys(flat).sort();
      dataToSign = sortedKeys.reduce((acc, key) => {
        const v = flat[key];
        return v != null ? acc + String(v) : acc;
      }, "");
    }

    // HMAC-SHA256 → Base64
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

    // Business logic
    const payload = JSON.parse(rawBodyString);
    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const { order, payment } = payload.data || {};
      console.log(`Processing success for Order: ${order?.order_id}`);
      // e.g. await PaymentDetails.create({ order, payment, timestamp: payload.event_time });
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).send("Internal Server Error");
  }
};
