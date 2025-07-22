// backend/controllers/payment-gateway-controllers/payment-verify.js
import dotenv from "dotenv";
dotenv.config();

import { Cashfree, CFEnvironment } from "cashfree-pg";

const cashfree = new Cashfree(
  CFEnvironment.PRODUCTION,
  process.env.CF_CLIENT_ID,
  process.env.CF_CLIENT_SECRET
);

const paymentVerify = async (req, res) => {
  const { orderId } = req.body;
  console.log("Payment verification called with orderId:", orderId);
  try {
    const response = await cashfree.PGOrderFetchPayments(orderId);
    console.log("Verification result:", response.data);

    res.status(200).json({
  order_status: response.data?.payment_entities?.[0]?.payment_status || "UNKNOWN",
  paymentDetails: response.data
});

  } catch (error) {
    console.error("Error verifying payment:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
};

export default paymentVerify;
