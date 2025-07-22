// backend/controllers/payment-gateway-controllers/payment-verify.js
import dotenv from "dotenv";
dotenv.config();
import PaymentDetails from "../../models/payment.details.model.js";

const paymentVerify = async (req, res) => {
  const { orderId } = req.body;
  console.log("Payment verification called with orderId:", orderId);
  try {
    const response = await PaymentDetails.findOne({ orderId });
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
