import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!receivedSignature || !timestamp) {
      return res.status(400).send('Invalid headers');
    }
    
    // The rawBody Buffer from express.raw()
    const rawBodyBuffer = req.body;

    // --- ✅ THE FINAL FIX ---
    // 1. First, parse the buffer that the server receives.
    const payloadObject = JSON.parse(rawBodyBuffer.toString('utf8'));

    // 2. Then, re-stringify it with standard formatting (2-space indentation).
    // This mimics what Render is doing and creates the *exact* string needed for the signature.
    const alteredBodyString = JSON.stringify(payloadObject, null, 2);
    
    // 3. Create the message using this newly created string.
    const message = timestamp + '.' + alteredBodyString;

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');
    
    // --- Verification ---
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'base64'),
      Buffer.from(receivedSignature, 'base64')
    );
    
    if (!isSignatureValid) {
      console.log('⚠️ Webhook signature mismatch.');
      console.log('Generated:', generatedSignature);
      console.log('Received: ', receivedSignature);
      return res.status(400).send('Invalid signature');
    }

    console.log('✅ Webhook signature verified successfully!');

    // Since we already parsed the payload, we can use 'payloadObject' directly.
    const payload = payloadObject;

    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { order, payment } = payload.data;
      await PaymentDetails.create({
        orderId: order.order_id,
        paymentId: payment.cf_payment_id,
        status: 'PAID',
        amount: order.order_amount,
        currency: order.order_currency,
      });
      console.log(`✅ Payment success for Order ${order.order_id} saved.`);
    }

    res.status(200).send('Webhook received successfully');
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    res.status(500).send('Server Error');
  }
};