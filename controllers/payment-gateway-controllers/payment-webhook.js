import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    // --- 1. Get Secret and Headers ---
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!receivedSignature || !timestamp) {
      console.log('⚠️ Webhook failed: Missing signature or timestamp headers.');
      return res.status(400).send('Invalid headers');
    }

    // --- 2. Generate Expected Signature ---
    const rawBody = req.body;
    
    // ✅ CRITICAL FIX: The signature string MUST join the timestamp and body with a period.
    const message = timestamp + '.' + rawBody.toString('utf8');

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');

    // --- 3. Compare Signatures ---
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

    // --- 4. Process the Payload ---
    const payload = JSON.parse(rawBody.toString('utf8'));

    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { order, payment } = payload.data;
      const orderId = order.order_id;
      const paymentId = payment.cf_payment_id;

      const existingPayment = await PaymentDetails.findOne({ orderId });
      if (existingPayment) {
        console.log(`Order ${orderId} already processed. Skipping.`);
        return res.status(200).send('Webhook already processed');
      }

      await PaymentDetails.create({
        orderId,
        paymentId,
        status: 'PAID',
        amount: order.order_amount,
        currency: order.order_currency,
      });

      console.log(`✅ Payment success for Order ${orderId} saved.`);
    }

    res.status(200).send('Webhook received successfully');
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    res.status(500).send('Server Error');
  }
};