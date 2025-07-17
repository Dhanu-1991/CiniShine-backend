import express from "express";
import payment from "../../controllers/payment-gateway-controllers/payment.js";
import paymentVerify from "../../controllers/payment-gateway-controllers/payment-verify.js";
import paymentWebhook from "../../controllers/payment-gateway-controllers/payment-webhook.js";

const router = express.Router();

router.post("/payment", payment);
router.post("/payment-verify", paymentVerify);
router.post("/payment-webhook", paymentWebhook); // ✅ proper webhook handler

export default router;
