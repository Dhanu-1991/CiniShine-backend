import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

// 🔁 Helper: Flatten nested object keys like a.b.c
const flattenObject = (obj, parentKey = '', result = {}) => {
  for (const key in obj) {
    const propName = parentKey ? `${parentKey}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      flattenObject(obj[key], propName, result);
    } else {
      result[propName] = obj[key];
    }
  }
  return result;
};

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-cf-signature'] || req.headers['x-webhook-signature'];

    if (!receivedSignature || !secret) {
      console.log('❌ Webhook failed: Missing signature or secret.');
      return res.status(400).send('Invalid headers or secret');
    }

    const rawBodyString = req.rawBody.toString('utf8');
    const payload = JSON.parse(rawBodyString);

    // ✅ Flatten payload and sort keys
    const flattened = flattenObject(payload);
    const sortedKeys = Object.keys(flattened).sort();

    // ✅ Concatenate only values in sorted key order
    let postData = '';
    for (const key of sortedKeys) {
      const value = flattened[key];
      if (value !== null && value !== undefined) {
        postData += String(value);
      }
    }

    // ✅ Generate signature using HMAC SHA256 + base64
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(postData)
      .digest('base64');

    // ✅ Compare signatures
    if (generatedSignature !== receivedSignature) {
      console.log('❌ Signature mismatch!');
      console.log('Generated:', generatedSignature);
      console.log('Received :', receivedSignature);
      return res.status(400).send('Invalid signature');
    }

    console.log('✅ Webhook signature verified successfully');

    // 🎯 Add business logic here
    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { order, payment } = payload.data || {};
      console.log(`✅ Payment received for Order: ${order?.order_id}`);
      // You can insert/save to DB using PaymentDetails model here
    }

    res.status(200).send('Webhook processed successfully.');
  } catch (err) {
    console.error('❌ Error processing webhook:', err.message);
    res.status(500).send('Internal Server Error');
  }
};
