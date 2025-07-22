import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];

    // Use raw body directly for signature verification
    const rawBody = req.body; // Buffer
    const rawBodyString = rawBody.toString('utf8');
    console.log("🔍 Raw body received:", req.body);
    console.log("✅ Is raw body a Buffer:", Buffer.isBuffer(req.body));

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    console.log('Generated Signature:', generatedSignature);
    console.log('Received Signature:', receivedSignature);

    if (receivedSignature !== generatedSignature) {
      console.log('⚠️ Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    const payload = JSON.parse(rawBodyString);

    if (payload.event === 'PAYMENT_SUCCESS_WEBHOOK') {
      const orderId = payload.data.order.order_id;
      const paymentId = payload.data.payment.payment_id;

      await PaymentDetails.create({
        orderId,
        paymentId,
        status: 'PAID',
        amount: payload.data.order.amount,
        currency: payload.data.order.currency,
      });

      console.log(`✅ Payment success for Order ${orderId}`);
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
};
