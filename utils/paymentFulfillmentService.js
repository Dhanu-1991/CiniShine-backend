import mongoose from "mongoose";
import PaymentDetails from "../models/payment.details.model.js";
import Purchase from "../models/purchase.model.js";
import Content from "../models/content.model.js";
import SecondaryWallet from "../models/secondaryWallet.model.js";
import { ensurePrimaryWallet, ensureSecondaryWallet, creditWallet } from "./walletService.js";

export const PLATFORM_CUT_PERCENT = 32;

/**
 * Fulfills a Wallet Recharge.
 * Handles the database transaction to credit the wallet and update PaymentDetails.
 */
export async function fulfillWalletRecharge({ orderId, paymentId, amount, currency, userId }) {
  console.log(`\n=================== [RECHARGE_FULFILL_INIT] ===================`);
  console.log(`Order: ${orderId} | PaymentID: ${paymentId} | User: ${userId} | Amount: ₹${amount}`);

  let existingPayment = await PaymentDetails.findOne({ orderId });
  if (existingPayment && existingPayment.status === "SUCCESS") {
    console.log(`[RECHARGE_FULFILL] [IDEMPOTENT_SKIP] Order ${orderId} already fulfilled.`);
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
    console.log(`✅ [RECHARGE_FULFILL_SUCCESS] Credited ₹${amount} to Primary Wallet of User ${userId} | Order: ${orderId}`);
    console.log(`=================== [RECHARGE_FULFILL_END] ===================\n`);
    return existingPayment;
  } catch (err) {
    console.error('❌ [RECHARGE_FULFILL_ERROR] Failed to process wallet recharge fulfillment:', err);
    throw err;
  } finally {
    await session.endSession();
  }
}

import { calculateTaxBreakdown } from './taxCalculator.js';

/**
 * Fulfills a PPV Purchase.
 * Handles creating the Purchase record, updating PaymentDetails, and crediting the creator.
 */
export async function fulfillPpvPurchase({ orderId, paymentId, amount, currency, userId, contentId }) {
  console.log(`\n=================== [PPV_PG_FULFILL_INIT] ===================`);
  console.log(`Order: ${orderId} | PaymentID: ${paymentId} | Buyer: ${userId} | Content: ${contentId} | Selling Price: ₹${amount}`);

  let existingPayment = await PaymentDetails.findOne({ orderId });
  if (existingPayment && existingPayment.status === "SUCCESS") {
    console.log(`[PPV_PG_FULFILL] [IDEMPOTENT_SKIP] Order ${orderId} already fulfilled.`);
    return existingPayment;
  }

  const tax = calculateTaxBreakdown(amount);
  console.log(`[PPV_PG_TAX_BREAKDOWN] Selling: ₹${tax.sellingPrice} | Base: ₹${tax.basePrice} | GST: ₹${tax.gstAmount} | Platform Comm: ₹${tax.platformCommission} | GST on Comm: ₹${tax.gstOnCommission} | TDS: ₹${tax.tdsAmount} | TCS: ₹${tax.tcsAmount} | Creator Net Payout: ₹${tax.creatorPayout}`);

  // 1. Create Purchase & Update PaymentDetails
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const purchase = await Purchase.create({
    contentId,
    buyerId: userId,
    orderId,
    paymentId,
    amount,
    currency,
    basePrice: tax.basePrice,
    gstAmount: tax.gstAmount,
    platformCommission: tax.platformCommission,
    gstOnCommission: tax.gstOnCommission,
    tdsAmount: tax.tdsAmount,
    tcsAmount: tax.tcsAmount,
    creatorPayout: tax.creatorPayout,
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
  console.log(`[PPV_PG_PURCHASE_CREATED] PurchaseID: ${purchase._id} | Order: ${orderId} | Status: active | ExpiresAt: ${expiresAt}`);

  // 2. Credit Creator
  try {
    if (contentId) {
      const content = await Content.findById(contentId).select('userId').lean();
      if (content?.userId) {
        const creatorId = content.userId.toString();
        const creatorAmount = tax.creatorPayout;
        let creatorWallet = await SecondaryWallet.findOne({ userId: creatorId });
        if (!creatorWallet) {
          console.log(`[PPV_PG_CREDIT] Creating Secondary Wallet for Creator ${creatorId}`);
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
                taxBreakdown: tax,
              },
              `ppv_earning_${orderId}`, session
            );
          });
          console.log(`✅ [PPV_PG_CREATOR_CREDITED] Credited Net Payout ₹${creatorAmount} to Creator ${creatorId} Secondary Wallet`);
        } finally {
          await session.endSession();
        }
      }
    }
  } catch (creatorWalletErr) {
    console.error('❌ [PPV_PG_CREATOR_CREDIT_ERROR] Failed to process creator wallet credit:', creatorWalletErr);
  }

  console.log(`=================== [PPV_PG_FULFILL_SUCCESS] ===================\n`);
  return existingPayment;
}
