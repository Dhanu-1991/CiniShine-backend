// backend/controllers/payment-gateway-controllers/payment.js
import dotenv from "dotenv";
dotenv.config();

import { Cashfree, CFEnvironment } from "cashfree-pg";
import generateOrderId from "./get.order.id.js";

// ✅ Correct instantiation for SDK v5.0.8
const cashfree = new Cashfree(CFEnvironment.PRODUCTION, process.env.CF_CLIENT_ID, process.env.CF_CLIENT_SECRET);

const payment = async (req, res) => {
  const { price } = req.body;
  console.log("Received price:", price);
  console.log("Calling generateOrderId function");

  const orderId = await generateOrderId();
  console.log("Generated order ID:", orderId);

  const request = {
    order_id: orderId,
    order_amount: price,
    order_currency: "INR",
    customer_details: {
      customer_id: "john_doe_123",
      customer_email: "john.doe@example.com",
      customer_phone: "9999999999"
    },
    order_meta: {
      return_url: `https://www.cashfree.com/devstudio/preview/pg/web/checkout?order_id=${orderId}`
    }
  };

  try {
    const response = await cashfree.PGCreateOrder(request);
    console.log("Payment session created successfully:", response.data);

    res.status(200).json({
  order_id: orderId,
  payment_session_id: response.data.payment_session_id, // ✅ required by SDK
});

  } catch (error) {
    console.error("Error creating payment session:", error?.response?.data || error.message);
    res.status(500).json({ error: "Failed to create payment session" });
  }
};

export default payment;
