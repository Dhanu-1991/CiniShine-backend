/**
 * Admin Email Service — sends emails to creators using Resend (preferred) or AWS SES (fallback).
 * Built on the same infrastructure as otpServiceEmail.js.
 * 
 * Templates:
 *  - contentRemoved  — auto-sent when admin removes/hides content
 *  - channelBanned   — auto-sent when admin bans a channel
 *  - channelUnbanned — auto-sent when admin unbans a channel
 *  - warning         — admin sends a warning to a creator
 *  - custom          — free-form email from admin
 */
import { Resend } from "resend";
import dotenv from "dotenv";
import { generateSettlementPdf } from '../utils/pdfGenerator.js';

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "Watchinit";

const getResendClient = () => {
    const key = process.env.RESEND_API_KEY;
    return key ? new Resend(key) : null;
};

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────

const templates = {
    contentRemoved: ({ creatorName, contentTitle, contentType, reason }) => ({
        subject: `[${PLATFORM_NAME}] Your ${contentType || 'content'} has been removed`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">Content Removed</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>We're writing to inform you that your ${contentType || 'content'} <strong>"${contentTitle}"</strong> has been removed from ${PLATFORM_NAME}.</p>
                    ${reason ? `<div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>` : ''}
                    <p>If you believe this action was taken in error, please contact our support team.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your ${contentType || 'content'} "${contentTitle}" has been removed from ${PLATFORM_NAME}. ${reason ? `Reason: ${reason}` : ''}`
    }),

    channelBanned: ({ creatorName, reason }) => ({
        subject: `[${PLATFORM_NAME}] Your channel has been suspended`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">Channel Suspended</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>Your channel on ${PLATFORM_NAME} has been <strong>suspended</strong>. During the suspension:</p>
                    <ul style="color: #ccc;">
                        <li>Your content will be hidden from the platform</li>
                        <li>You will not be able to upload new content</li>
                        <li>Your channel page will be unavailable</li>
                    </ul>
                    ${reason ? `<div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>` : ''}
                    <p>If you believe this was an error, please reach out to our support team with your account details.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your channel on ${PLATFORM_NAME} has been suspended. ${reason ? `Reason: ${reason}` : ''} Contact support if you believe this is an error.`
    }),

    channelUnbanned: ({ creatorName }) => ({
        subject: `[${PLATFORM_NAME}] Your channel has been reinstated`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Channel Reinstated</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>Great news! Your channel on ${PLATFORM_NAME} has been <strong>reinstated</strong>. You can now:</p>
                    <ul style="color: #ccc;">
                        <li>Upload new content</li>
                        <li>Your existing content is visible again</li>
                        <li>Interact with your audience</li>
                    </ul>
                    <p>Thank you for your patience and we look forward to seeing your content.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your channel on ${PLATFORM_NAME} has been reinstated. You can now upload and interact again.`
    }),

    warning: ({ creatorName, warningMessage }) => ({
        subject: `[${PLATFORM_NAME}] Important notice about your account`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #fbbf24; margin-top: 0;">Account Notice</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;">${warningMessage}</p>
                    </div>
                    <p>Please review our community guidelines and ensure your content complies with our policies.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">From Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, ${warningMessage}`
    }),

    kycApproved: ({ creatorName }) => ({
        subject: `[${PLATFORM_NAME}] KYC Verification Successful`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">KYC Verified</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>Great news! Your KYC details have been successfully verified by our team. Your wallet is now fully approved for payouts and monetization features.</p>
                    <p>Thank you for submitting your details!</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your KYC details have been successfully verified! Your wallet is now fully approved.`
    }),

    kycRejected: ({ creatorName, rejectionReason }) => ({
        subject: `[${PLATFORM_NAME}] Action Required: KYC Verification Failed`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">KYC Update Required</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>We encountered an issue while verifying your submitted KYC details.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason for Rejection:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${rejectionReason}</p>
                    </div>
                    <p>Please log in to your dashboard and update your KYC details to ensure uninterrupted monetization and payouts.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your KYC verification failed. Reason: ${rejectionReason}. Please log in and update your details.`
    }),

    custom: ({ creatorName, subject: customSubject, body }) => ({
        subject: customSubject || `[${PLATFORM_NAME}] Message from the team`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <div style="line-height: 1.6;">${body.replace(/\n/g, '<br>')}</div>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">From Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, ${body}`
    }),

    payoutInitiated: ({ creatorName, netAmount, grossAmount, payoutMonth }) => ({
        subject: `[${PLATFORM_NAME}] Payout Initiated: ₹${netAmount}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Payout Initiated</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>Your payout for <strong>${payoutMonth}</strong> has been initiated!</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #10b981; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;"><strong>Amount to be Credited:</strong> ₹${netAmount}</p>
                        <p style="margin: 4px 0 0; color: #888; font-size: 13px;">Gross Balance Cleared: ₹${grossAmount}</p>
                    </div>
                    <p>Your amount will be credited to your bank account within 24 hours.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your payout of ₹${netAmount} for ${payoutMonth} has been initiated and will be credited within 24 hours.`
    }),

    payoutCompleted: ({ creatorName, userName, payoutMonth }) => ({
        subject: `[${PLATFORM_NAME}] Payout Settlement Processed: ${payoutMonth}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #111827; color: #e5e7eb; border-radius: 16px; overflow: hidden; border: 1px solid #374151;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #047857 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px; font-weight: 800;">${PLATFORM_NAME} OFFICIAL SETTLEMENT</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Payout Settlement Processed</h2>
                    <p style="font-size: 15px; color: #e5e7eb;">Dear <strong>${creatorName || userName || 'Creator'}</strong>,</p>
                    <p style="font-size: 15px; color: #d1d5db; line-height: 1.6;">
                        Your payouts for <strong>${payoutMonth}</strong> have been processed. Please find the details in the attached PDF invoice below.
                    </p>
                    <div style="background: #1f2937; border: 1px solid #374151; padding: 14px 18px; border-radius: 10px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 13px; color: #34d399; font-weight: 600;">
                            📎 Attached File: Tax_Invoice_${payoutMonth}.pdf
                        </p>
                    </div>
                    <p style="color: #6b7280; font-size: 12px; margin-top: 24px; border-top: 1px solid #374151; padding-top: 16px;">
                        This is an official automated notification from ${PLATFORM_NAME} Technologies Private Limited.
                    </p>
                </div>
            </div>`,
        text: `Dear ${creatorName || userName || 'Creator'}, your payouts for ${payoutMonth} have been processed. Please find the details in the attached PDF invoice below.`
    }),
};

// Pre-built quick templates for admin UI
export const QUICK_TEMPLATES = [
    { id: 'welcome', name: 'Welcome', subject: `Welcome to ${PLATFORM_NAME}!`, body: `We're excited to have you on ${PLATFORM_NAME}. Start by setting up your channel and uploading your first content. Our team is here to help if you need anything!` },
    { id: 'guideline_reminder', name: 'Guideline Reminder', subject: `Reminder: ${PLATFORM_NAME} Community Guidelines`, body: `We noticed some of your recent content may not fully align with our community guidelines. Please review our policies at your earliest convenience to ensure continued compliance. Repeated violations may result in content removal or account restrictions.` },
    { id: 'great_content', name: 'Great Content', subject: `Keep up the great work!`, body: `We wanted to reach out and let you know that your content has been performing well! Keep creating amazing content and engaging with your audience.` },
    { id: 'verification_needed', name: 'Verification Needed', subject: `Action Required: Account Verification`, body: `We need to verify some details about your account. Please contact our support team with your account information at your earliest convenience.` },
    { id: 'copyright_notice', name: 'Copyright Notice', subject: `Copyright Notice`, body: `We've received a copyright claim regarding one of your uploads. Please review your content and ensure all material used has proper licensing or attribution. Failure to address this may result in content removal.` },
];

// ─── CORE SEND FUNCTION ───────────────────────────────────────────────────

/**
 * Send an email strictly using Resend API.
 * @param {string} to — recipient email address
 * @param {string} subject — email subject
 * @param {string} html — HTML email body
 * @param {string} [text] — plain text fallback
 * @param {Array} [attachments] — array of attachment objects
 * @returns {Promise<boolean>} — true if sent successfully
 */
async function sendEmail(to, subject, html, text, attachments = []) {
    if (!to) {
        console.error('[AdminEmail] No recipient email provided');
        return false;
    }

    const resendClient = getResendClient();
    if (!resendClient) {
        console.error('[AdminEmail] RESEND_API_KEY is not configured');
        return false;
    }

    const defaultFrom = process.env.RESEND_FROM || (FROM_ADDRESS && !FROM_ADDRESS.includes('example.com') ? FROM_ADDRESS : 'Watchinit <onboarding@resend.dev>');

    try {
        const options = {
            from: defaultFrom,
            to,
            subject,
            html,
            ...(text ? { text } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
        const resp = await resendClient.emails.send(options);
        console.log('[AdminEmail] Resend send response:', JSON.stringify(resp));

        if (resp && resp.error) {
            console.error('[AdminEmail] Resend error:', resp.error);
            if (defaultFrom !== 'Watchinit <onboarding@resend.dev>') {
                console.log('[AdminEmail] Attempting resend with fallback sender domain onboarding@resend.dev...');
                const fbResp = await resendClient.emails.send({
                    ...options,
                    from: 'Watchinit <onboarding@resend.dev>',
                });
                console.log('[AdminEmail] Resend fallback response:', JSON.stringify(fbResp));
                if (fbResp && !fbResp.error && (fbResp.id || fbResp.data?.id)) {
                    console.log(`[AdminEmail] Sent via Resend fallback to ${to}: "${subject}"`);
                    return true;
                }
            }
            return false;
        }

        const succeeded = Boolean(resp && (resp.id || resp.data?.id));
        if (succeeded) {
            console.log(`[AdminEmail] Sent via Resend to ${to}: "${subject}"`);
            return true;
        }
    } catch (err) {
        console.error('[AdminEmail] Resend exception:', err.message || err);
        if (defaultFrom !== 'Watchinit <onboarding@resend.dev>') {
            try {
                const fbResp = await resendClient.emails.send({
                    from: 'Watchinit <onboarding@resend.dev>',
                    to,
                    subject,
                    html,
                    ...(text ? { text } : {}),
                    ...(attachments && attachments.length > 0 ? { attachments } : {}),
                });
                console.log('[AdminEmail] Resend fallback catch response:', JSON.stringify(fbResp));
                if (fbResp && !fbResp.error && (fbResp.id || fbResp.data?.id)) {
                    console.log(`[AdminEmail] Sent via Resend fallback to ${to}: "${subject}"`);
                    return true;
                }
            } catch (fallbackErr) {
                console.error('[AdminEmail] Resend fallback catch error:', fallbackErr.message || fallbackErr);
            }
        }
    }

    return false;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────

/**
 * Send a templated email to a creator.
 * @param {string} templateName — one of: contentRemoved, channelBanned, channelUnbanned, warning, custom, payoutInitiated, payoutCompleted
 * @param {string} recipientEmail — creator's email address
 * @param {Object} data — template data (creatorName, reason, contentTitle, etc.)
 * @returns {Promise<boolean>}
 */
export async function sendAdminEmail(templateName, recipientEmail, data = {}) {
    const templateFn = templates[templateName];
    if (!templateFn) {
        console.error(`[AdminEmail] Unknown template: ${templateName}`);
        return false;
    }

    const { subject, html, text } = templateFn(data);
    let attachments = [];

    // If sending completed payout settlement email, generate PDF, upload to AWS S3, and attach!
    if (templateName === 'payoutCompleted') {
        try {
            const pdfBuffer = await generateSettlementPdf(data);
            
            // Save generated PDF to AWS S3 before dispatch
            const s3Bucket = process.env.S3_BUCKET;
            if (s3Bucket) {
                try {
                    const rawUid = data.userId?._id || data.userId || data.creatorId || 'creator';
                    const uid = typeof rawUid === 'object' ? rawUid.toString() : String(rawUid);
                    const s3Key = `settlement-invoices/${data.payoutMonth || 'general'}/${uid}_Tax_Invoice_${Date.now()}.pdf`;
                    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
                    const { S3Client } = await import('@aws-sdk/client-s3');
                    const s3Client = new S3Client({ region: REGION });
                    await s3Client.send(new PutObjectCommand({
                        Bucket: s3Bucket,
                        Key: s3Key,
                        Body: pdfBuffer,
                        ContentType: 'application/pdf',
                        ServerSideEncryption: 'AES256',
                    }));
                    console.log(`✅ [AdminEmail] Saved generated PDF invoice to AWS S3: s3://${s3Bucket}/${s3Key}`);

                    // Save invoice key and URL to Payout document if payoutId is available
                    if (data.payoutId) {
                        try {
                            const Payout = (await import('../models/payout.model.js')).default;
                            const cdnUrl = process.env.VITE_CDN_URL || process.env.CDN_URL || `https://${s3Bucket}.s3.amazonaws.com`;
                            const invoiceUrl = `${cdnUrl}/${s3Key}`;
                            await Payout.findByIdAndUpdate(data.payoutId, {
                                invoiceS3Key: s3Key,
                                invoiceUrl,
                            });
                            console.log(`✅ [AdminEmail] Updated Payout ${data.payoutId} in MongoDB with AWS S3 Key: ${s3Key}`);
                        } catch (payoutUpdateErr) {
                            console.error('❌ [AdminEmail] Failed to update Payout document with invoiceUrl:', payoutUpdateErr.message);
                        }
                    }
                } catch (s3Err) {
                    console.error('❌ [AdminEmail] AWS S3 PDF save error:', s3Err.message || s3Err);
                }
            }

            attachments.push({
                filename: `Tax_Invoice_${data.payoutMonth || 'Settlement'}.pdf`,
                content: pdfBuffer,
            });
        } catch (pdfErr) {
            console.error('[AdminEmail] PDF generation error:', pdfErr);
        }
    }

    return sendEmail(recipientEmail, subject, html, text, attachments);
}

/**
 * Send a free-form email (custom template wrapper).
 */
export async function sendCustomEmail(recipientEmail, subject, body, creatorName, adminName) {
    return sendAdminEmail('custom', recipientEmail, { creatorName, subject, body, adminName });
}

export default { sendAdminEmail, sendCustomEmail, QUICK_TEMPLATES };
