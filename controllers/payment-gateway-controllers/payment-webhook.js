import crypto from 'crypto';
import dotenv from 'dotenv';
// We are removing the database model for this test to ensure it has no side effects.
// import PaymentDetails from '../../models/payment.details.model.js'; 

dotenv.config();

export const handleCashfreeWebhook = async (req, res) => {
  console.log('--- STARTING WEBHOOK DIAGNOSTIC ---');
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!secret || !receivedSignature || !timestamp) {
      console.log('❌ Critical Error: Missing secret key or webhook headers.');
      return res.status(400).send('Invalid headers or missing secret');
    }
    
    // Use the rawBody from our custom middleware in index.js
    const rawBodyBuffer = req.rawBody;

    if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
      console.log('❌ Critical Error: Raw body is empty. The getRawBody middleware might have failed.');
      return res.status(400).send('Empty request body');
    }

    const rawBodyString = rawBodyBuffer.toString('utf8');
    const message = timestamp + '.' + rawBodyString;

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');

    // --- DETAILED LOGGING ---
    console.log(`\n[1] SECRET KEY (first 5 chars): ${secret.substring(0, 5)}...`);
    console.log(`[2] TIMESTAMP: ${timestamp}`);
    console.log(`[3] RECEIVED SIGNATURE: ${receivedSignature}`);
    console.log(`[4] GENERATED SIGNATURE: ${generatedSignature}`);
    console.log(`[5] BODY BUFFER LENGTH: ${rawBodyBuffer.length} bytes`);
    
    // Log the body as a HEX string to see all invisible characters
    console.log(`[6] BODY AS HEX STRING: \n${rawBodyBuffer.toString('hex')}`);
    
    console.log('\n--- ENDING WEBHOOK DIAGNOSTIC ---');


    if (generatedSignature !== receivedSignature) {
        // We already know it mismatches, just sending a response.
        return res.status(400).send('Signature mismatch confirmed.');
    }

    // If it ever succeeds, we log it.
    console.log('✅ SIGNATURE MATCHED! (This is unexpected)');
    res.status(200).send('Webhook received successfully');

  } catch (err) {
    console.error('❌ FATAL ERROR in webhook handler:', err.message);
    res.status(500).send('Server Error');
  }
};