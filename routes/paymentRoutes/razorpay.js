import express from "express";
import payment from "../../controllers/payment-gateway-controllers/razorpay.js";
import paymentVerify from "../../controllers/payment-gateway-controllers/razorpay-verify.js";
import { checkAccess, getUserPurchases, getContentRevenue } from "../../controllers/payment-gateway-controllers/purchaseController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

router.post("/payment", universalTokenVerifier, payment);
router.post("/payment-verify", paymentVerify);
// Webhook route is handled at a higher level (like index.js) if it needs raw body parsing,
// but for Razorpay, express.json() works fine if the signature verification stringifies req.body, 
// OR we can use express.raw for precise signature verification.
// Standard implementation often works with JSON stringify but raw is safer.

router.get("/purchase/check/:contentId", universalTokenVerifier, checkAccess);
router.get("/purchases", universalTokenVerifier, getUserPurchases);
router.get("/purchase/revenue/:contentId", universalTokenVerifier, getContentRevenue);

export default router;
