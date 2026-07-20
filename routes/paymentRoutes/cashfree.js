import express from "express";
import payment from "../../controllers/payment-gateway-controllers/payment.js";
import paymentVerify from "../../controllers/payment-gateway-controllers/payment-verify.js";
import { handleCashfreeWebhook } from "../../controllers/payment-gateway-controllers/payment-webhook.js";
import { checkAccess, getUserPurchases, getContentRevenue } from "../../controllers/payment-gateway-controllers/purchaseController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

router.post("/payment", universalTokenVerifier, payment);
router.post("/payment-verify", paymentVerify);
// Webhook route is mounted in index.js to handle raw body parsing correctly

router.get("/purchase/check/:contentId", universalTokenVerifier, checkAccess);
router.get("/purchases", universalTokenVerifier, getUserPurchases);
router.get("/purchase/revenue/:contentId", universalTokenVerifier, getContentRevenue);

export default router;
