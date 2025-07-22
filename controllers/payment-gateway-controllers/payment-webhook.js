import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';
dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];

    // 🔸 Use raw body for signature verification
    const rawBody = req.body; // This is a Buffer (because of express.raw middleware)

    // 🔐 Step 1: Generate HMAC-SHA256 signature
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    console.log('Generated Signature:', generatedSignature);
    console.log('Received Signature:', receivedSignature);

    // 🔎 Step 2: Compare signatures
    if (receivedSignature !== generatedSignature) {
      console.log('⚠️ Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    // ✅ Step 3: Parse payload safely
    const payload = JSON.parse(rawBody.toString());
    console.log('Received Webhook:', payload);

    // 📦 Step 4: Handle event
    if (payload.event === 'PAYMENT_SUCCESS_WEBHOOK') {
      const orderId = payload.data.order.order_id;
      const paymentId = payload.data.payment.payment_id;
      const amount = payload.data.order.order_amount;
      const currency = payload.data.order.order_currency;

      console.log(`✅ Payment success for Order ${orderId}`);

      await PaymentDetails.create({
        orderId,
        paymentId,
        status: 'PAID',
        amount,
        currency,
      });

      // Optionally: send confirmation email, update order table, etc.
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
};
