import dotenv from "dotenv";
dotenv.config();
import PaymentDetails from "../../models/payment.details.model.js";
import axios from "axios";
import mongoose from "mongoose";
import { fulfillWalletRecharge, fulfillPpvPurchase } from "../../utils/paymentFulfillmentService.js";

const paymentVerify = async (req, res) => {
  const { orderId } = req.body;
  console.log(`\n=================== [CASHFREE_VERIFY_INIT] ===================`);
  console.log(`OrderID: ${orderId}`);
  try {
    let response = await PaymentDetails.findOne({ orderId });
    
    // Fallback: If not found in DB, or if still PENDING (webhook delayed), check Cashfree directly
    if ((!response || response.status === "PENDING") && orderId) {
      console.log(`[CASHFREE_VERIFY] Order ${orderId} is missing or PENDING in DB. Querying Cashfree API directly...`);
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
          console.log(`[CASHFREE_VERIFY] Cashfree confirms Order ${orderId} is PAID. Fulfilling locally...`);
          
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
          console.log(`[CASHFREE_VERIFY] Cashfree reports Order ${orderId} status: ${cfOrder.order_status}`);
          return res.status(200).json({
            order_status: cfOrder.order_status,
            paymentDetails: null
          });
        }
      } catch (cfErr) {
        console.error("❌ [CASHFREE_VERIFY_API_ERROR]", cfErr.response?.data || cfErr.message);
      }
    }
    
    console.log(`[CASHFREE_VERIFY_RESULT] Order ${orderId} DB Status: ${response?.status || 'UNKNOWN'}`);

    let paymentDetailsObj = response ? (response.toObject ? response.toObject() : { ...response }) : null;
    if (paymentDetailsObj && paymentDetailsObj.contentId) {
      const Content = mongoose.model("Content");
      const contentDoc = await Content.findById(paymentDetailsObj.contentId).select("contentType").lean();
      if (contentDoc) {
        paymentDetailsObj.contentType = contentDoc.contentType;
      }
    }

    console.log(`=================== [CASHFREE_VERIFY_END] ===================\n`);
    res.status(200).json({
      order_status: response?.status || "UNKNOWN",
      paymentDetails: paymentDetailsObj
    });

  } catch (error) {
    console.error("❌ [CASHFREE_VERIFY_ERROR]", error.response?.data || error.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
};

export default paymentVerify;
