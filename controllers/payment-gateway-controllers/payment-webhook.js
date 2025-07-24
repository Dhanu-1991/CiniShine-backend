import crypto from 'crypto';
import dotenv from 'dotenv';
import PaymentDetails from '../../models/payment.details.model.js';

dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!receivedSignature || !timestamp || !secret) {
      console.log('Webhook failed: Missing signature, timestamp, or secret.');
      return res.status(400).send('Invalid configuration or headers.');
    }
    console.log(req.headers);
    console.log(req.rawBody);
  

    // Use the pristine raw body captured by our middleware.
    const rawBodyString = req.rawBody.toString('utf8');
    console.log('Raw body string:', rawBodyString);
    // Create the message exactly as Cashfree does.
    const message = timestamp + '.' + rawBodyString;

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');
    
    // Securely compare the signature from Cashfree with the one we generated.
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'base64'),
      Buffer.from(receivedSignature, 'base64')
    );
    
    if (!isSignatureValid) {
      console.log('⚠️ Webhook signature mismatch! Request is not authentic.');
      return res.status(400).send('Invalid signature');
    }

    // --- Signature is VALID ---
    console.log('✅ Webhook signature verified successfully!');

    // Now, it's safe to parse the JSON and use the data.
    const payload = JSON.parse(rawBodyString);

    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { order, payment } = payload.data;

      // TODO: Add your business logic here (e.g., check for duplicates, update DB)
      await PaymentDetails.create({
        orderId: order.order_id,
        paymentId: payment.cf_payment_id,
        status: 'PAID',
        amount: order.order_amount,
        currency: order.order_currency,
      });
      
      console.log(`Payment details for Order ${order.order_id} saved.`);
    }

    res.status(200).send('Webhook processed successfully.');
  } catch (err) {
    console.error('❌ Error in webhook handler:', err.message);
    res.status(500).send('Internal Server Error');
  }
};