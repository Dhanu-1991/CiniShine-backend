import crypto from "crypto";
import dotenv from "dotenv";
import PaymentDetails from "../../models/payment.details.model.js";
import Purchase from "../../models/purchase.model.js";
import Content from "../../models/content.model.js";
import { ensureSecondaryWallet, creditWallet } from "../../utils/walletService.js";
import SecondaryWallet from "../../models/secondaryWallet.model.js";
import mongoose from "mongoose";

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
      return res.status(400).send("Invalid signature or secret");
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
      
      const existingPayment = await PaymentDetails.findOne({ orderId });
      if (!existingPayment) {
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        
        const purchase = await Purchase.create({
          contentId,
          buyerId: userId,
          orderId,
          paymentId,
          amount,
          currency,
          status: 'active',
          expiresAt
        });
        
        await PaymentDetails.create({
          orderId,
          paymentId,
          amount,
          currency,
          status: "SUCCESS",
          userId,
          contentId,
          purchaseId: purchase._id
        });
        console.log(`Purchase and Payment details created for Order: ${orderId}`);

        // Credit creator's secondary wallet with 70% of PPV earnings
        try {
          if (contentId) {
            const content = await Content.findById(contentId).select('userId').lean();
            if (content?.userId) {
              const creatorId = content.userId.toString();
              const creatorAmount = Math.round(amount * (100 - PLATFORM_CUT_PERCENT) / 100);
              // Find or create creator's secondary wallet
              let creatorWallet = await SecondaryWallet.findOne({ userId: creatorId });
              if (!creatorWallet) {
                creatorWallet = await ensureSecondaryWallet(creatorId);
              }
              const session = await mongoose.startSession();
              try {
                await session.withTransaction(async () => {
                  await creditWallet(
                    creatorWallet._id, 'secondary', creatorAmount, 'ppv_earning_credit',
                    {
                      relatedContentId: contentId,
                      relatedPurchaseId: purchase._id,
                      relatedOrderId: orderId,
                      relatedBuyerId: userId,
                    },
                    `ppv_earning_${orderId}`, session
                  );
                });
                console.log(`✅ Credited ₹${creatorAmount} (70% of ₹${amount}) to creator ${creatorId} secondary wallet`);
              } finally {
                await session.endSession();
              }
            }
          }
        } catch (walletErr) {
          console.error('❌ Failed to credit creator wallet (purchase still valid):', walletErr);
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
