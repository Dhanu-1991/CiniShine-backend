import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";
import User from "../models/user.model.js";
import Content from "../models/content.model.js";

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "Watchinit";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://watchinit.com";

const ses = new SESClient({ region: REGION });
const getResendClient = () => {
    const key = process.env.RESEND_API_KEY;
    return key ? new Resend(key) : null;
};

/**
 * Dispatch email via Resend (preferred) or AWS SES (fallback)
 */
async function sendRawEmail(to, subject, html, text) {
    if (!to || !to.includes('@')) {
        console.warn(`[PaymentEmail] Invalid recipient email: "${to}"`);
        return false;
    }

    const resendClient = getResendClient();
    const defaultFrom = process.env.RESEND_FROM || (FROM_ADDRESS && !FROM_ADDRESS.includes('example.com') ? FROM_ADDRESS : `${PLATFORM_NAME} <onboarding@resend.dev>`);

    if (resendClient) {
        try {
            const resp = await resendClient.emails.send({
                from: defaultFrom,
                to,
                subject,
                html,
                text,
            });

            console.log('[PaymentEmail] Resend response:', JSON.stringify(resp));
            if (resp && !resp.error && (resp.id || resp.data?.id)) {
                console.log(`✅ [PaymentEmail] Sent via Resend to ${to}: "${subject}"`);
                return true;
            }
            if (resp && resp.error && defaultFrom !== `${PLATFORM_NAME} <onboarding@resend.dev>`) {
                const fbResp = await resendClient.emails.send({
                    from: `${PLATFORM_NAME} <onboarding@resend.dev>`,
                    to,
                    subject,
                    html,
                    text,
                });
                if (fbResp && !fbResp.error && (fbResp.id || fbResp.data?.id)) {
                    console.log(`✅ [PaymentEmail] Sent via Resend fallback to ${to}: "${subject}"`);
                    return true;
                }
            }
        } catch (err) {
            console.error('[PaymentEmail] Resend error:', err.message || err);
        }
    }

    // Fallback to AWS SES
    try {
        const params = {
            Destination: { ToAddresses: [to] },
            Message: {
                Body: {
                    Html: { Charset: "UTF-8", Data: html },
                    Text: { Charset: "UTF-8", Data: text },
                },
                Subject: { Charset: "UTF-8", Data: subject },
            },
            Source: FROM_ADDRESS,
        };

        const command = new SendEmailCommand(params);
        const response = await ses.send(command);

        if (response && response.MessageId) {
            console.log(`✅ [PaymentEmail] Sent via AWS SES to ${to}: "${subject}"`);
            return true;
        }
    } catch (error) {
        console.error('[PaymentEmail] SES error:', error.message || error);
    }

    return false;
}

/**
 * Send Wallet Recharge Confirmation Email
 */
export async function sendWalletRechargeEmail({ userId, amount, orderId, paymentId }) {
    try {
        if (!userId) return false;
        const user = await User.findById(userId).select('email contact userName channelName').lean();
        if (!user) return false;

        const recipientEmail = user.email || (user.contact && user.contact.includes('@') ? user.contact : null);
        if (!recipientEmail) {
            console.warn(`[PaymentEmail] User ${userId} has no valid email address to send recharge notification.`);
            return false;
        }

        const userName = user.userName || user.channelName || 'User';
        const formattedAmount = Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const dateTimeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        const refId = orderId || paymentId || 'N/A';

        const subject = `[${PLATFORM_NAME}] Wallet Recharged: ₹${formattedAmount}`;

        const html = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 28px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px;">${PLATFORM_NAME}</h1>
                    <p style="color: #a7f3d0; margin: 6px 0 0 0; font-size: 13px; font-weight: 600;">Wallet Recharge Confirmation</p>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0; font-size: 20px;">₹${formattedAmount} Added to Your Wallet 🎉</h2>
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">Hi <strong>${userName}</strong>,</p>
                    <p style="font-size: 14px; color: #94a3b8; line-height: 1.6;">
                        Your <strong>Wallet</strong> balance has been successfully credited. You can now use your wallet balance to instantly rent movies, video content, and audio tracks across ${PLATFORM_NAME}.
                    </p>

                    <div style="background: #1e293b; border: 1px solid #334155; padding: 20px; border-radius: 12px; margin: 24px 0;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Amount Credited:</td>
                                <td style="padding: 8px 0; color: #34d399; font-weight: 700; text-align: right;">₹${formattedAmount}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Reference / Order ID:</td>
                                <td style="padding: 8px 0; color: #f8fafc; font-family: monospace; font-size: 13px; text-align: right;">${refId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Target Wallet:</td>
                                <td style="padding: 8px 0; color: #f8fafc; text-align: right;">Wallet (Recharge & Spend)</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Date & Time:</td>
                                <td style="padding: 8px 0; color: #f8fafc; text-align: right;">${dateTimeStr}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 28px;">
                        <a href="${FRONTEND_URL}/wallet" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-weight: 700; font-size: 14px;">View Wallet Balance</a>
                    </div>

                    <p style="color: #64748b; font-size: 12px; margin-top: 32px; border-top: 1px solid #1e293b; padding-top: 20px; text-align: center;">
                        This is an automated operational notification from ${PLATFORM_NAME}. If you did not initiate this transaction, please contact support.
                    </p>
                </div>
            </div>
        `;

        const text = `${PLATFORM_NAME} - Wallet Recharge Confirmation\n\nHi ${userName},\n\n₹${formattedAmount} has been successfully added to your Wallet balance.\n\nOrder Ref: ${refId}\nDate: ${dateTimeStr}\n\nView your balance at: ${FRONTEND_URL}/wallet`;

        return await sendRawEmail(recipientEmail, subject, html, text);
    } catch (err) {
        console.error('❌ Error sending wallet recharge email:', err);
        return false;
    }
}

/**
 * Send PPV Content Rental Confirmation Email
 */
export async function sendPpvRentalEmail({ userId, contentId, amount, orderId, paymentId, paymentMethod = 'Online Payment' }) {
    try {
        if (!userId || !contentId) return false;

        const [user, content] = await Promise.all([
            User.findById(userId).select('email contact userName channelName').lean(),
            Content.findById(contentId).select('title contentType duration').lean(),
        ]);

        if (!user || !content) return false;

        const recipientEmail = user.email || (user.contact && user.contact.includes('@') ? user.contact : null);
        if (!recipientEmail) {
            console.warn(`[PaymentEmail] User ${userId} has no valid email address to send PPV rental notification.`);
            return false;
        }

        const userName = user.userName || user.channelName || 'User';
        const contentTitle = content.title || 'Untitled Content';
        const isAudio = content.contentType === 'audio';
        const contentTypeLabel = isAudio ? 'Audio Track' : 'Video Content';
        const formattedAmount = Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const refId = orderId || paymentId || 'N/A';

        // 48 hours expiry date formatted
        const expiryDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const expiryFormatted = expiryDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

        const contentRoute = isAudio ? `/audio/${contentId}` : `/watch/${contentId}`;
        const contentUrl = `${FRONTEND_URL}${contentRoute}`;
        const watchOrListenText = isAudio ? '🎵 Listen Now' : '▶ Watch Now';

        const subject = `[${PLATFORM_NAME}] Content Rented: "${contentTitle}"`;

        const html = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b;">
                <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 28px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px;">${PLATFORM_NAME}</h1>
                    <p style="color: #c7d2fe; margin: 6px 0 0 0; font-size: 13px; font-weight: 600;">Content Rental Confirmation</p>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #818cf8; margin-top: 0; font-size: 20px;">You've Rented "${contentTitle}" 🍿</h2>
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">Hi <strong>${userName}</strong>,</p>
                    <p style="font-size: 14px; color: #94a3b8; line-height: 1.6;">
                        Thank you for your purchase! You have been granted <strong>48 hours of unlimited access</strong> to watch or listen to this ${contentTypeLabel.toLowerCase()}.
                    </p>

                    <div style="background: #1e293b; border: 1px solid #334155; padding: 20px; border-radius: 12px; margin: 24px 0;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Rented Item:</td>
                                <td style="padding: 8px 0; color: #f8fafc; font-weight: 600; text-align: right;">${contentTitle}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Format:</td>
                                <td style="padding: 8px 0; color: #f8fafc; text-align: right;">${contentTypeLabel}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Amount Paid:</td>
                                <td style="padding: 8px 0; color: #818cf8; font-weight: 700; text-align: right;">₹${formattedAmount}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Payment Method:</td>
                                <td style="padding: 8px 0; color: #f8fafc; text-align: right;">${paymentMethod}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Access Expiration:</td>
                                <td style="padding: 8px 0; color: #f59e0b; font-weight: 600; text-align: right;">${expiryFormatted}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #94a3b8;">Order Ref:</td>
                                <td style="padding: 8px 0; color: #f8fafc; font-family: monospace; font-size: 13px; text-align: right;">${refId}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 28px;">
                        <a href="${contentUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-weight: 700; font-size: 14px;">${watchOrListenText}</a>
                    </div>

                    <p style="color: #64748b; font-size: 12px; margin-top: 32px; border-top: 1px solid #1e293b; padding-top: 20px; text-align: center;">
                        This is an automated operational receipt from ${PLATFORM_NAME}. Enjoy your content!
                    </p>
                </div>
            </div>
        `;

        const text = `${PLATFORM_NAME} - Content Rental Confirmation\n\nHi ${userName},\n\nYou have successfully rented "${contentTitle}" for ₹${formattedAmount}.\n\nAccess Expiry: ${expiryFormatted}\nPayment Method: ${paymentMethod}\nOrder Ref: ${refId}\n\nAccess your content at: ${contentUrl}`;

        return await sendRawEmail(recipientEmail, subject, html, text);
    } catch (err) {
        console.error('❌ Error sending PPV rental email:', err);
        return false;
    }
}
