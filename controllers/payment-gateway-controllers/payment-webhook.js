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

    // Use the rawBody from our custom middleware. It's a Buffer.
    // We convert it to a string for the signature calculation.
    const rawBodyString = req.rawBody.toString('utf8');

    // Create the message with the pristine, unaltered body string.
    const message = timestamp + '.' + rawBodyString;

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');
    
    // Perform the final, correct comparison
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

    // Parse the trusted raw body to get the JSON object
    const payload = JSON.parse(rawBodyString);

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