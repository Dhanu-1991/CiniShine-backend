import express from "express";
import cashfreeRouter from "./cashfree.js";
import razorpayRouter from "./razorpay.js";

const router = express.Router();

// Middleware to dynamically route based on ACTIVE_PAYMENT_GATEWAY
router.use((req, res, next) => {
  const gateway = process.env.ACTIVE_PAYMENT_GATEWAY?.toLowerCase() || 'cashfree';
  if (gateway === 'razorpay') {
    return razorpayRouter(req, res, next);
  } else {
    return cashfreeRouter(req, res, next);
  }
});

export default router;
