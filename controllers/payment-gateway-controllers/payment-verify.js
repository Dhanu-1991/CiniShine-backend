import dotenv from "dotenv";
dotenv.config();
import PaymentDetails from "../../models/payment.details.model.js";
import axios from "axios";
import mongoose from "mongoose";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

const paymentVerify = async (req, res) => {
  const { orderId } = req.body;
  console.log("Payment verification called with orderId:", orderId);
  try {
    let response = await PaymentDetails.findOne({ orderId });
    
    // Fallback: If not found in DB, or if still PENDING (webhook delayed), check Cashfree directly
    if ((!response || response.status === "PENDING") && orderId) {
      console.log(`Order ${orderId} is missing or PENDING. Querying Cashfree directly...`);
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
            response = await fulfillWalletRecharge({
              orderId,
              paymentId: cfOrder.cf_order_id,
              amount,
              currency,
              userId
            });
          } else {
            // --- PPV PURCHASE FALLBACK LOGIC ---
            const contentId = cfOrder.order_tags?.contentId;
            response = await fulfillPpvPurchase({
              orderId,
              paymentId: cfOrder.cf_order_id,
              amount,
              currency,
              userId,
              contentId
            });
          }
        } else {
          // If it's FAILED, ACTIVE, etc., just return that status directly to the frontend!
          // We don't save it to the DB here (webhook will handle it if it arrives),
          // but at least the frontend won't get stuck on UNKNOWN.
          return res.status(200).json({
            order_status: cfOrder.order_status,
            paymentDetails: null
          });
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
