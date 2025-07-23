import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

/**
 * A custom replacer function for JSON.stringify.
 * It converts any number that is a whole number (e.g., 1.00) into an integer (e.g., 1).
 * This is to counteract the number formatting changes from the hosting environment.
 */
function normalizeNumbers(key, value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return parseInt(value.toFixed(0), 10);
  }
  return value;
}

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!receivedSignature || !timestamp) {
      return res.status(400).send('Invalid headers');
    }

    // This is the altered body buffer from the Render environment.
    const rawBodyBuffer = req.rawBody;
    const alteredBodyString = rawBodyBuffer.toString('utf8');

    // --- ✅ THE FINAL FIX ---
    // 1. Parse the altered body we received.
    const payloadObject = JSON.parse(alteredBodyString);

    // 2. Re-stringify the object, but use our custom replacer to fix the numbers.
    // This will convert "amount:1.00" back to "amount:1".
    const normalizedBodyString = JSON.stringify(payloadObject, normalizeNumbers);

    // 3. Create the signature from this normalized string.
    const message = timestamp + '.' + normalizedBodyString;

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');
    
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'base64'),
      Buffer.from(receivedSignature, 'base64')
    );
    
    if (!isSignatureValid) {
      console.log('⚠️ Final attempt failed. Signature mismatch persists.');
      console.log('Generated:', generatedSignature);
      console.log('Received: ', receivedSignature);
      return res.status(400).send('Invalid signature');
    }

    console.log('✅ Webhook signature verified successfully!');

    // Use the parsed object for business logic
    const payload = payloadObject;

    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      // ... your database logic ...
      console.log(`Processing payment for Order ${payload.data.order.order_id}`);
    }

    res.status(200).send('Webhook received successfully');
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    res.status(500).send('Server Error');
  }
};