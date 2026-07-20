/**
 * Recharge Webhook Controller
 * Handles Cashfree webhooks for wallet recharge payments.
 * Same signature verification as payment-webhook.js.
 */
import crypto from 'crypto';
import { executeRecharge } from '../../utils/walletService.js';

export const handleRechargeWebhook = async (req, res) => {
    try {
        const rawBody = req.body;
        const signature = req.headers['x-webhook-signature'] || req.headers['x-cf-signature'];
        const webhookVersion = req.headers['x-webhook-version'];

        if (!signature) {
            return res.status(400).json({ error: 'Missing webhook signature' });
        }

        // Verify signature
        const secret = process.env.CASHFREE_WEBHOOK_SECRET;
        let computedSignature;

        if (webhookVersion === '2025-01-01') {
            computedSignature = crypto.createHmac('sha256', secret)
                .update(rawBody.toString())
                .digest('base64');
        } else {
            const payload = JSON.parse(rawBody.toString());
            const flatValues = flattenAndSort(payload);
            computedSignature = crypto.createHmac('sha256', secret)
                .update(flatValues)
                .digest('base64');
        }

        if (computedSignature !== signature) {
            console.error('❌ Recharge webhook: signature mismatch');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const payload = JSON.parse(rawBody.toString());
        const eventType = payload.type || payload.event;

        if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
            const order = payload.data?.order || payload.data?.payment?.order || {};
            const payment = payload.data?.payment || {};

            const orderId = order.order_id || payment.cf_payment_id;
            const amount = Number(order.order_amount || payment.payment_amount);
            const orderTags = order.order_tags || order.order_meta || {};

            // Only process wallet recharge webhooks
            if (orderTags.type !== 'wallet_recharge') {
                return res.status(200).json({ message: 'Not a recharge webhook, ignored' });
            }

            const userId = orderTags.userId;
            if (!userId) {
                console.error('❌ Recharge webhook: missing userId in order_tags');
                return res.status(400).json({ error: 'Missing userId' });
            }

            // Execute recharge — idempotent via idempotencyKey
            const txn = await executeRecharge(userId, amount, orderId);

            console.log(`✅ Wallet recharged: user=${userId}, amount=₹${amount}, order=${orderId}`);
            return res.status(200).json({ success: true, transactionId: txn._id });
        }

        res.status(200).json({ message: 'Webhook received' });
    } catch (error) {
        console.error('❌ Recharge webhook error:', error);
        // Always return 200 to Cashfree to prevent retries on application errors
        res.status(200).json({ error: 'Webhook processing failed' });
    }
};

// Helper: flatten nested object and sort keys for older webhook signature format
function flattenAndSort(obj, prefix = '') {
    const values = [];
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            values.push(flattenAndSort(obj[key], fullKey));
        } else {
            values.push(String(obj[key]));
        }
    }
    return values.join('');
}
