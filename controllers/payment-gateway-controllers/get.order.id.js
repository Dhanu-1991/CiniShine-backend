// backend/controllers/payment-gateway-controllers/get.order.id.js
import crypto from "crypto";

const generateOrderId = () => {
  return "ORDER_" + crypto.randomBytes(6).toString("hex").toUpperCase();
};

export default generateOrderId;
