import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';
dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET; // use .env
    const receivedSignature = req.headers['x-webhook-signature'];
    const payload = req.body.toString(); // Must match raw body

    // 🔐 Step 1: Generate signature from payload
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64');

    // 🔎 Step 2: Compare signatures
    if (receivedSignature !== generatedSignature) {
      console.log('⚠️ Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    // ✅ Step 3: Signature verified. Process data
    const eventData = req.body;

    if (eventData.event === 'PAYMENT_SUCCESS_WEBHOOK') {
      const orderId = eventData.data.order.order_id;
      const paymentId = eventData.data.payment.payment_id;

      // 👉 Update DB (mark as paid, send mail, etc.)
      console.log(`✅ Payment success for Order ${orderId}`);
      await PaymentDetails.create({

        orderId,
        paymentId,
        status: 'PAID',
        amount: eventData.data.order.amount,
        currency: eventData.data.order.currency,
      });

      // await Order.updateOne({ orderId }, { status: 'PAID', paymentId });
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
};
