import dotenv from "dotenv";
dotenv.config();
import PaymentDetails from "../../models/payment.details.model.js";
import axios from "axios";
import mongoose from "mongoose";
import { ensurePrimaryWallet, creditWallet } from "../../utils/walletService.js";

const paymentVerify = async (req, res) => {
  const { orderId } = req.body;
  console.log("Payment verification called with orderId:", orderId);
  try {
    let response = await PaymentDetails.findOne({ orderId });
    
    // Fallback: If not found in DB, check Cashfree directly (Webhook might have failed/delayed)
    if (!response && orderId) {
      console.log(`Order ${orderId} missing in DB. Querying Cashfree directly...`);
      const cfEnv = process.env.CASHFREE_MODE?.trim() === 'production' 
        ? 'https://api.cashfree.com/pg/orders' 
        : 'https://sandbox.cashfree.com/pg/orders';
        
      try {
        const cfResponse = await axios.get(`${cfEnv}/${orderId}`, {
          headers: {
            'x-client-id': process.env.CF_CLIENT_ID?.trim(),
            'x-client-secret': process.env.CF_CLIENT_SECRET?.trim(),
            'x-api-version': '2023-08-01'
          }
        });
        
        const cfOrder = cfResponse.data;
        if (cfOrder.order_status === "PAID") {
          console.log(`Cashfree confirms order ${orderId} is PAID. Fulfilling locally...`);
          
          const amount = cfOrder.order_amount;
          const currency = cfOrder.order_currency;
          const userId = cfOrder.order_tags?.userId || cfOrder.customer_details?.customer_id;
          const type = cfOrder.order_tags?.type || "ppv_purchase";
          
          if (type === "wallet_recharge" && userId) {
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
                  `recharge_fallback_${orderId}`,
                  session
                );
                
                response = await PaymentDetails.create([{
                  orderId,
                  paymentId: cfOrder.cf_order_id,
                  amount,
                  currency,
                  status: "SUCCESS",
                  userId
                }], { session });
              });
              console.log(`✅ [Fallback] Credited ₹${amount} to user ${userId} primary wallet for recharge`);
              response = response[0];
            } catch (fallbackErr) {
              console.error('❌ Failed to process wallet recharge fallback', fallbackErr);
            } finally {
              await session.endSession();
            }
          }
        }
      } catch (cfErr) {
        console.error("Cashfree API fetch error:", cfErr.response?.data || cfErr.message);
      }
    }
    
    console.log("Verification result:", response);

    res.status(200).json({
      order_status: response?.status || "UNKNOWN",
      paymentDetails: response
    });

  } catch (error) {
    console.error("Error verifying payment:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
};

export default paymentVerify;
