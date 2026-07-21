import mongoose from "mongoose";
import PaymentDetails from "../models/payment.details.model.js";
import Purchase from "../models/purchase.model.js";
import Content from "../models/content.model.js";
import SecondaryWallet from "../models/secondaryWallet.model.js";
import { ensurePrimaryWallet, ensureSecondaryWallet, creditWallet } from "./walletService.js";

export const PLATFORM_CUT_PERCENT = 30;

/**
 * Fulfills a Wallet Recharge.
 * Handles the database transaction to credit the wallet and update PaymentDetails.
 */
export async function fulfillWalletRecharge({ orderId, paymentId, amount, currency, userId }) {
  let existingPayment = await PaymentDetails.findOne({ orderId });
  if (existingPayment && existingPayment.status === "SUCCESS") {
    console.log(`Order ${orderId} already fulfilled.`);
    return existingPayment;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await ensurePrimaryWallet(userId);
      await creditWallet(
        wallet._id,
        'primary',
        amount,
        'recharge',
        { relatedOrderId: orderId, relatedBuyerId: userId },
        `recharge_${orderId}`,
        session
      );
      
      if (existingPayment) {
        existingPayment.status = "SUCCESS";
        existingPayment.paymentId = paymentId;
        existingPayment.amount = amount;
        existingPayment.currency = currency;
        await existingPayment.save({ session });
      } else {
        const newRecord = await PaymentDetails.create([{
          orderId,
          paymentId,
          amount,
          currency,
          status: "SUCCESS",
          userId
        }], { session });
        existingPayment = newRecord[0];
      }
    });
    console.log(`✅ Fulfilled Wallet Recharge: Credited ₹${amount} to user ${userId}`);
    return existingPayment;
  } catch (err) {
    console.error('❌ Failed to process wallet recharge fulfillment', err);
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Fulfills a PPV Purchase.
 * Handles creating the Purchase record, updating PaymentDetails, and crediting the creator.
 */
export async function fulfillPpvPurchase({ orderId, paymentId, amount, currency, userId, contentId }) {
  let existingPayment = await PaymentDetails.findOne({ orderId });
  if (existingPayment && existingPayment.status === "SUCCESS") {
    console.log(`Order ${orderId} already fulfilled.`);
    return existingPayment;
  }

  // 1. Create Purchase & Update PaymentDetails
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
  
  if (existingPayment) {
    existingPayment.status = "SUCCESS";
    existingPayment.paymentId = paymentId;
    existingPayment.amount = amount;
    existingPayment.currency = currency;
    existingPayment.purchaseId = purchase._id;
    await existingPayment.save();
  } else {
    existingPayment = await PaymentDetails.create({
      orderId,
      paymentId,
      amount,
      currency,
      status: "SUCCESS",
      userId,
      contentId,
      purchaseId: purchase._id
    });
  }
  console.log(`✅ Fulfilled PPV Purchase for Order: ${orderId}`);

  // 2. Credit Creator
  try {
    if (contentId) {
      const content = await Content.findById(contentId).select('userId').lean();
      if (content?.userId) {
        const creatorId = content.userId.toString();
        const creatorAmount = Math.round(amount * (100 - PLATFORM_CUT_PERCENT) / 100);
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
          console.log(`✅ Credited ₹${creatorAmount} to creator ${creatorId} secondary wallet`);
        } finally {
          await session.endSession();
        }
      }
    }
  } catch (creatorWalletErr) {
    console.error('❌ Failed to process creator wallet credit', creatorWalletErr);
  }

  return existingPayment;
}
