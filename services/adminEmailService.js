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
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "Watchinit";

const ses = new SESClient({ region: REGION });
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────

const templates = {
    contentRemoved: ({ creatorName, contentTitle, contentType, reason, adminName }) => ({
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
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from ${PLATFORM_NAME} moderation team${adminName ? ` (via ${adminName})` : ''}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your ${contentType || 'content'} "${contentTitle}" has been removed from ${PLATFORM_NAME}. ${reason ? `Reason: ${reason}` : ''}`
    }),

    channelBanned: ({ creatorName, reason, adminName }) => ({
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
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from ${PLATFORM_NAME} moderation team${adminName ? ` (via ${adminName})` : ''}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your channel on ${PLATFORM_NAME} has been suspended. ${reason ? `Reason: ${reason}` : ''} Contact support if you believe this is an error.`
    }),

    channelUnbanned: ({ creatorName, adminName }) => ({
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
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from ${PLATFORM_NAME}${adminName ? ` (via ${adminName})` : ''}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your channel on ${PLATFORM_NAME} has been reinstated. You can now upload and interact again.`
    }),

    warning: ({ creatorName, warningMessage, adminName }) => ({
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
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">From ${PLATFORM_NAME} moderation team${adminName ? ` (${adminName})` : ''}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, ${warningMessage}`
    }),

    custom: ({ creatorName, subject: customSubject, body, adminName }) => ({
        subject: customSubject || `[${PLATFORM_NAME}] Message from the team`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <div style="line-height: 1.6;">${body.replace(/\n/g, '<br>')}</div>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">From ${PLATFORM_NAME} team${adminName ? ` (${adminName})` : ''}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, ${body}`
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
 * Send an email using Resend (preferred) or SES (fallback).
 * @param {string} to — recipient email address
 * @param {string} subject — email subject
 * @param {string} html — HTML email body
 * @param {string} [text] — plain text fallback
 * @returns {Promise<boolean>} — true if sent successfully
 */
async function sendEmail(to, subject, html, text) {
    if (!to) {
        console.error('[AdminEmail] No recipient email provided');
        return false;
    }

    // Prefer Resend
    if (resendClient) {
        try {
            const resp = await resendClient.emails.send({
                from: process.env.RESEND_FROM || FROM_ADDRESS,
                to,
                subject,
                html,
                ...(text ? { text } : {}),
            });
            const succeeded = Boolean(resp && (resp.id || resp.messageId || resp.data?.id));
            if (succeeded) {
                console.log(`[AdminEmail] Sent via Resend to ${to}: "${subject}"`);
                return true;
            }
            console.error('[AdminEmail] Resend did not return an id:', resp);
        } catch (err) {
            console.error('[AdminEmail] Resend error:', err.message);
            if (err?.message?.includes('domain is not verified') || err?.message?.includes('validation_error')) {
                return false;
            }
            // Fall through to SES
        }
    }

    // Fallback to SES
    try {
        const params = {
            Destination: { ToAddresses: [to] },
            Message: {
                Body: {
                    Html: { Charset: "UTF-8", Data: html },
                    ...(text ? { Text: { Charset: "UTF-8", Data: text } } : {}),
                },
                Subject: { Charset: "UTF-8", Data: subject },
            },
            Source: FROM_ADDRESS,
        };
        const response = await ses.send(new SendEmailCommand(params));
        if (response?.MessageId) {
            console.log(`[AdminEmail] Sent via SES to ${to}: "${subject}"`);
            return true;
        }
        console.error('[AdminEmail] SES no MessageId');
        return false;
    } catch (error) {
        console.error('[AdminEmail] SES error:', error.message);
        return false;
    }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────

/**
 * Send a templated email to a creator.
 * @param {string} templateName — one of: contentRemoved, channelBanned, channelUnbanned, warning, custom
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
    return sendEmail(recipientEmail, subject, html, text);
}

/**
 * Send a free-form email (custom template wrapper).
 */
export async function sendCustomEmail(recipientEmail, subject, body, creatorName, adminName) {
    return sendAdminEmail('custom', recipientEmail, { creatorName, subject, body, adminName });
}

export default { sendAdminEmail, sendCustomEmail, QUICK_TEMPLATES };
