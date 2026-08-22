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
                    <p>Great news! Your KYC details have been successfully verified by our team. Your Payout Balance is now fully approved for month-end payouts and monetization features.</p>
                    <p>Thank you for submitting your details!</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, your KYC details have been successfully verified! Your Payout Balance is now fully approved.`
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

    custom: ({ creatorName, subject: customSubject, body }) => {
        let cleanBody = (body || '').trim();
        // Remove duplicate leading "Hi <Name>," or "Hi <Name>" if present in body
        cleanBody = cleanBody.replace(/^Hi\s+[^,\n]+,?\s*/i, '').trim();

        let htmlFormattedBody = cleanBody.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #818cf8; font-weight: bold; text-decoration: underline;">$1</a>');
        htmlFormattedBody = htmlFormattedBody.replace(/\n/g, '<br>');

        return {
            subject: customSubject || `[${PLATFORM_NAME}] Operational Account Update`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b;">
                    <span style="display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; mso-hide:all;">Official WatchInit account operational notice regarding wallets, payouts, and platform policies.</span>
                    <div style="background: #1e1b4b; border-bottom: 1px solid #312e81; padding: 24px 32px;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; tracking-tight: -0.02em;">WATCHIN IT Official Notice</h1>
                    </div>
                    <div style="padding: 32px;">
                        <p style="margin-top: 0; font-size: 15px; color: #f8fafc;">Hi <strong>${creatorName}</strong>,</p>
                        <div style="line-height: 1.65; color: #e2e8f0; font-size: 14px;">${htmlFormattedBody}</div>
                        <div style="margin-top: 32px; padding-top: 20px; border-t: 1px solid #334155; font-size: 12px; color: #94a3b8;">
                            <p style="margin: 0;">This is an official operational notice from Team ${PLATFORM_NAME}. Please do not reply to this email.</p>
                            <p style="margin: 4px 0 0; color: #64748b;">If you need any assistance, please write to us at <a href="mailto:admin@watchinit.com" style="color: #818cf8; text-decoration: underline;">admin@watchinit.com</a>.</p>
                        </div>
                    </div>
                </div>`,
            text: `Hi ${creatorName},\n\n${cleanBody}\n\n---\nTeam ${PLATFORM_NAME}\nContact: admin@watchinit.com`
        };
    },

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

    partialPayoutInitiated: ({ creatorName, netAmount, grossAmount, payoutMonth, reason, remainingBalance }) => ({
        subject: `[${PLATFORM_NAME}] Partial Payout Initiated: ₹${netAmount}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #fbbf24; margin-top: 0;">Partial Payout Initiated</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>A partial payout for <strong>${payoutMonth}</strong> has been initiated for your account.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;"><strong>Amount to be Credited:</strong> ₹${netAmount}</p>
                        <p style="margin: 4px 0 0; color: #888; font-size: 13px;">Partial Amount Processed: ₹${grossAmount}</p>
                        <p style="margin: 4px 0 0; color: #888; font-size: 13px;">Remaining Payout Balance: ₹${typeof remainingBalance === 'number' ? remainingBalance.toFixed(2) : remainingBalance}</p>
                    </div>
                    <div style="background: #2a2a3e; border-left: 4px solid #ef4444; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #fca5a5; font-size: 14px;"><strong>Reason for Partial Payout:</strong></p>
                        <p style="margin: 4px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>
                    <p>Your partial payout amount will be credited to your bank account within 24 hours.</p>
                    <p style="color: #9ca3af; font-size: 13px;">If you have any queries regarding this partial payout, please contact us at <a href="mailto:admin@watchinit.com" style="color: #818cf8;">admin@watchinit.com</a>.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, a partial payout of ₹${netAmount} for ${payoutMonth} has been initiated. Reason: ${reason}. Remaining Payout Balance: ₹${typeof remainingBalance === 'number' ? remainingBalance.toFixed(2) : remainingBalance}. If you have any queries, please contact admin@watchinit.com.`
    }),

    inactiveCreatorNudge: ({ creatorName }) => ({
        subject: `We miss you on ${PLATFORM_NAME}! Your audience is waiting`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #60a5fa; margin-top: 0;">We miss you on Watchin It!</h2>
                    <p>Hi <strong>${creatorName}</strong>,</p>
                    <p>It's been a while since you last uploaded content on Watchin It, and we wanted to check in!</p>
                    <p>Your channel still has viewers discovering your existing content, and they'd love to see more from you. Here are a few reasons to come back:</p>
                    <ul style="color: #ccc; line-height: 1.6;">
                        <li>💰 Earn engagement payouts (CPM) on every view your content receives</li>
                        <li>🎬 Monetize premium content with our Pay-Per-View rental system</li>
                        <li>👥 Grow your fanbase — your existing followers are still active</li>
                        <li>🎁 Refer other creators and earn ₹25 per approved referral</li>
                    </ul>
                    <p>Log in and upload your next piece today!</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${creatorName}, we miss you on ${PLATFORM_NAME}! Your audience is waiting for new content.`
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

    engagementPayoutCredited: ({ creatorName, totalAmount, contentCount, payoutMonth, contentBreakdown = [] }) => {
        const formattedAmount = Number(totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const dateTimeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        const FRONTEND_URL = process.env.FRONTEND_URL || "https://watchinit.com";

        const topContentsHtml = (contentBreakdown || []).slice(0, 5).map(c => `
            <tr>
                <td style="padding: 8px 12px; border-bottom: 1px solid #1e293b; color: #f8fafc; font-size: 13px;">${c.contentTitle || 'Untitled'}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #1e293b; color: #94a3b8; font-size: 13px; text-align: right;">${c.metrics?.views?.toLocaleString() || 0}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #1e293b; color: #10b981; font-size: 13px; font-weight: 600; text-align: right;">₹${Number(c.payoutAmount || 0).toFixed(2)}</td>
            </tr>
        `).join('');

        return {
            subject: `[${PLATFORM_NAME}] ✨ Engagement Earnings Credited: ₹${formattedAmount}`,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b;">
                    <div style="background: linear-gradient(135deg, #059669 0%, #0d9488 100%); padding: 28px 32px;">
                        <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px;">${PLATFORM_NAME}</h1>
                        <p style="color: #a7f3d0; margin: 6px 0 0 0; font-size: 13px; font-weight: 600;">Engagement Revenue Distribution (${payoutMonth})</p>
                    </div>
                    <div style="padding: 32px;">
                        <h2 style="color: #34d399; margin-top: 0; font-size: 20px;">₹${formattedAmount} Credited to Your Payout Balance ✨</h2>
                        <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">Hi <strong>${creatorName}</strong>,</p>
                        <p style="font-size: 14px; color: #94a3b8; line-height: 1.6;">
                            We are pleased to inform you that your engagement-based content earnings for <strong>${payoutMonth}</strong> have been calculated and successfully credited to your <strong>Payout Balance</strong>.
                        </p>

                        <div style="background: #1e293b; border: 1px solid #334155; padding: 20px; border-radius: 12px; margin: 24px 0;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                                <tr>
                                    <td style="padding: 8px 0; color: #94a3b8;">Total Amount Credited:</td>
                                    <td style="padding: 8px 0; color: #34d399; font-weight: 700; text-align: right; font-size: 16px;">₹${formattedAmount}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #94a3b8;">Eligible Content Items:</td>
                                    <td style="padding: 8px 0; color: #f8fafc; text-align: right;">${contentCount} content(s)</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #94a3b8;">Credited Wallet:</td>
                                    <td style="padding: 8px 0; color: #f8fafc; text-align: right;">Payout Balance</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #94a3b8;">Credit Date:</td>
                                    <td style="padding: 8px 0; color: #f8fafc; text-align: right;">${dateTimeStr}</td>
                                </tr>
                            </table>
                        </div>

                        ${contentBreakdown && contentBreakdown.length > 0 ? `
                        <div style="margin: 24px 0;">
                            <h3 style="color: #f8fafc; font-size: 14px; font-weight: 600; margin-bottom: 12px;">Top Earning Content Breakdown</h3>
                            <table style="width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 8px; overflow: hidden; border: 1px solid #334155;">
                                <thead>
                                    <tr style="background: #1e293b;">
                                        <th style="padding: 8px 12px; text-align: left; color: #94a3b8; font-size: 12px; font-weight: 600;">Title</th>
                                        <th style="padding: 8px 12px; text-align: right; color: #94a3b8; font-size: 12px; font-weight: 600;">Views</th>
                                        <th style="padding: 8px 12px; text-align: right; color: #94a3b8; font-size: 12px; font-weight: 600;">Earnings</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${topContentsHtml}
                                </tbody>
                            </table>
                        </div>
                        ` : ''}

                        <div style="text-align: center; margin-top: 28px;">
                            <a href="${FRONTEND_URL}/wallet" style="display: inline-block; background: linear-gradient(135deg, #059669 0%, #0d9488 100%); color: white; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-weight: 700; font-size: 14px;">View Wallet & Transactions</a>
                        </div>

                        <p style="color: #64748b; font-size: 12px; margin-top: 32px; border-top: 1px solid #1e293b; padding-top: 20px; text-align: center;">
                            This is an automated operational credit notification from ${PLATFORM_NAME}. Your earnings are calculated dynamically based on total watch time, view completion rate, and audience engagement metrics.
                        </p>
                    </div>
                </div>
            `,
            text: `${PLATFORM_NAME} - Engagement Earnings Credited\n\nHi ${creatorName},\n\n₹${formattedAmount} has been credited to your Payout Balance for ${payoutMonth}.\n\nView details in your wallet: ${FRONTEND_URL}/wallet`
        };
    },

    referralApprovedReferrer: ({ referrerName, referredName, bonusAmount }) => ({
        subject: `[${PLATFORM_NAME}] 🎊 Referral Approved! You earned ₹${bonusAmount}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Referral Successful!</h2>
                    <p>Hi <strong>${referrerName}</strong>,</p>
                    <p>Great news! Your friend <strong>${referredName}</strong> has successfully uploaded content, and your referral has been approved.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #10b981; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;"><strong>Bonus Credited:</strong> ₹${bonusAmount}</p>
                    </div>
                    <p>The bonus has been credited to your Payout Balance.</p>
                    <p>Keep referring to earn more!</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${referrerName}, your referral for ${referredName} was approved. You earned ₹${bonusAmount}.`
    }),

    referralApprovedReferred: ({ referredName, referrerName, bonusAmount }) => ({
        subject: `[${PLATFORM_NAME}] 🎉 Welcome Bonus Approved!`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Welcome Bonus Credited!</h2>
                    <p>Hi <strong>${referredName}</strong>,</p>
                    <p>Congratulations! You successfully uploaded your first content via <strong>${referrerName}</strong>'s referral.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #10b981; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;"><strong>Bonus Credited:</strong> ₹${bonusAmount}</p>
                    </div>
                    <p>The bonus has been credited to your Wallet.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${referredName}, your welcome bonus of ₹${bonusAmount} for joining via ${referrerName} has been approved.`
    }),

    referralRejectedReferrer: ({ referrerName, referredName, reason }) => ({
        subject: `[${PLATFORM_NAME}] Referral Update: ${referredName}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">Referral Rejected</h2>
                    <p>Hi <strong>${referrerName}</strong>,</p>
                    <p>Unfortunately, your referral for <strong>${referredName}</strong> has been rejected by our team.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>
                    <p>Please review our referral program guidelines.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${referrerName}, your referral for ${referredName} was rejected. Reason: ${reason}`
    }),

    referralRejectedReferred: ({ referredName, referrerName, reason }) => ({
        subject: `[${PLATFORM_NAME}] Welcome Bonus Update`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">Welcome Bonus Update</h2>
                    <p>Hi <strong>${referredName}</strong>,</p>
                    <p>Unfortunately, your welcome bonus from <strong>${referrerName}</strong>'s referral could not be processed.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>
                    <p>If you believe this is an error, please contact our support team.</p>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${referredName}, your welcome bonus for joining via ${referrerName} was rejected. Reason: ${reason}`
    }),

    referralPartialApproved: ({ userName, bonusAmount }) => ({
        subject: `[${PLATFORM_NAME}] 🎊 Referral Bonus Approved! You earned ₹${bonusAmount}`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #34d399; margin-top: 0;">Referral Bonus Approved!</h2>
                    <p>Hi <strong>${userName}</strong>,</p>
                    <p>Great news! Your referral bonus has been credited.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #10b981; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #e0e0e0;"><strong>Bonus Credited:</strong> ₹${bonusAmount}</p>
                    </div>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${userName}, your referral bonus of ₹${bonusAmount} was approved.`
    }),

    referralPartialRejected: ({ userName, reason }) => ({
        subject: `[${PLATFORM_NAME}] Referral Update`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #e63946 0%, #c1121f 100%); padding: 24px 32px;">
                    <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                </div>
                <div style="padding: 32px;">
                    <h2 style="color: #ff6b6b; margin-top: 0;">Referral Not Approved</h2>
                    <p>Hi <strong>${userName}</strong>,</p>
                    <p>Unfortunately, your referral was not approved by our team.</p>
                    <div style="background: #2a2a3e; border-left: 4px solid #e63946; padding: 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #ff9999;"><strong>Reason:</strong></p>
                        <p style="margin: 8px 0 0; color: #e0e0e0;">${reason}</p>
                    </div>
                    <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                </div>
            </div>`,
        text: `Hi ${userName}, your referral was not approved. Reason: ${reason}`
    }),

    walletAdjusted: ({ creatorName, action, amount, walletType, reason }) => {
        const isPayout = typeof walletType === 'string' && (
            walletType.toLowerCase().includes('payout') ||
            walletType.toLowerCase().includes('secondary') ||
            walletType.toLowerCase().includes('settlement')
        );
        const targetName = isPayout ? 'Payout Balance' : 'Wallet';
        const formattedAmount = Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return {
            subject: `[${PLATFORM_NAME}] ${targetName} ${action === 'credit' ? 'Credited' : 'Debited'} Notification`,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #e0e0e0; border-radius: 12px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, ${action === 'credit' ? '#10b981 0%, #059669' : '#e63946 0%, #c1121f'} 100%); padding: 24px 32px;">
                        <h1 style="color: white; margin: 0; font-size: 20px;">${PLATFORM_NAME}</h1>
                    </div>
                    <div style="padding: 32px;">
                        <h2 style="color: ${action === 'credit' ? '#34d399' : '#ff6b6b'}; margin-top: 0;">${targetName} ${action === 'credit' ? 'Credited' : 'Debited'}</h2>
                        <p>Hi <strong>${creatorName}</strong>,</p>
                        <p>Your ${targetName} has been <strong>${action === 'credit' ? 'credited' : 'debited'}</strong>.</p>
                        <div style="background: #2a2a3e; border-left: 4px solid ${action === 'credit' ? '#10b981' : '#e63946'}; padding: 16px; border-radius: 4px; margin: 16px 0;">
                            <p style="margin: 0; color: #e0e0e0;"><strong>Amount:</strong> ₹${formattedAmount}</p>
                            ${reason ? `<p style="margin: 8px 0 0; color: #e0e0e0;"><strong>Reason:</strong> ${reason}</p>` : ''}
                        </div>
                        <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated message from Team ${PLATFORM_NAME}.</p>
                    </div>
                </div>`,
            text: `Hi ${creatorName}, your ${targetName} was ${action === 'credit' ? 'credited' : 'debited'} by ₹${formattedAmount}.${reason ? ` Reason: ${reason}` : ''}`
        };
    },
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
 * @param {string} templateName — one of: contentRemoved, channelBanned, channelUnbanned, warning, custom, payoutInitiated, partialPayoutInitiated, payoutCompleted, walletAdjusted, engagementPayoutCredited, referralApprovedReferrer, referralApprovedReferred
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

    // Ensure userName is prioritized over channelName for all email greetings
    const preferredName = data.userName || data.creatorName || data.referrerName || data.referredName || 'User';
    const normalizedData = {
        ...data,
        creatorName: data.userName || data.creatorName || 'User',
        userName: data.userName || data.creatorName || 'User',
        referrerName: data.referrerUserName || data.referrerName || data.userName || 'User',
        referredName: data.referredUserName || data.referredName || 'User',
    };

    const { subject, html, text } = templateFn(normalizedData);
    let attachments = [];

    // If sending completed payout settlement email, fetch saved PDF from AWS S3 (or generate if first time) and attach!
    if (templateName === 'payoutCompleted') {
        try {
            let pdfBuffer = null;
            const s3Bucket = process.env.S3_BUCKET;

            // Step A: Check if saved invoice S3 key is passed or stored on Payout document
            let s3Key = data.invoiceS3Key;
            if (!s3Key && data.payoutId) {
                try {
                    const Payout = (await import('../models/payout.model.js')).default;
                    const payoutDoc = await Payout.findById(data.payoutId).select('invoiceS3Key').lean();
                    if (payoutDoc?.invoiceS3Key) {
                        s3Key = payoutDoc.invoiceS3Key;
                    }
                } catch (dbErr) {
                    console.error('[AdminEmail] Error fetching Payout invoiceS3Key:', dbErr.message);
                }
            }

            // Step B: If saved S3 key exists, fetch the EXACT saved PDF file from AWS S3! (DO NOT generate a new one)
            if (s3Key && s3Bucket) {
                try {
                    console.log(`[AdminEmail] Fetching existing saved PDF invoice from AWS S3: s3://${s3Bucket}/${s3Key}`);
                    const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
                    const s3Client = new S3Client({
                        region: REGION,
                        credentials: {
                            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                        }
                    });
                    const s3Obj = await s3Client.send(new GetObjectCommand({
                        Bucket: s3Bucket,
                        Key: s3Key,
                    }));

                    const chunks = [];
                    for await (const chunk of s3Obj.Body) {
                        chunks.push(chunk);
                    }
                    pdfBuffer = Buffer.concat(chunks);
                    console.log(`✅ [AdminEmail] Successfully fetched saved PDF (${pdfBuffer.length} bytes) from S3: s3://${s3Bucket}/${s3Key}`);
                } catch (s3FetchErr) {
                    console.warn(`⚠️ [AdminEmail] S3 fetch warning (${s3FetchErr.message}). Will generate PDF as fallback.`);
                }
            }

            // Step C: Only generate & upload new PDF if no saved file exists in AWS S3 (e.g. initial settlement creation)
            if (!pdfBuffer) {
                console.log(`[AdminEmail] No existing saved S3 PDF found. Generating new settlement PDF invoice...`);
                pdfBuffer = await generateSettlementPdf(data);

                // Save generated PDF to AWS S3 before dispatch
                if (s3Bucket) {
                    try {
                        const newS3Key = `settlement-invoices/${data.payoutMonth || 'general'}/${data.userId || data.creatorId || 'creator'}_Tax_Invoice_${Date.now()}.pdf`;
                        const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
                        const s3Client = new S3Client({
                            region: REGION,
                            credentials: {
                                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                            }
                        });
                        await s3Client.send(new PutObjectCommand({
                            Bucket: s3Bucket,
                            Key: newS3Key,
                            Body: pdfBuffer,
                            ContentType: 'application/pdf',
                            ServerSideEncryption: 'AES256',
                        }));
                        console.log(`[AdminEmail] Saved generated PDF invoice to AWS S3: s3://${s3Bucket}/${newS3Key}`);

                        // Save invoice key and URL to Payout document if payoutId is available
                        if (data.payoutId) {
                            try {
                                const Payout = (await import('../models/payout.model.js')).default;
                                const cdnUrl = process.env.VITE_CDN_URL || process.env.CDN_URL || `https://${s3Bucket}.s3.amazonaws.com`;
                                const invoiceUrl = `${cdnUrl}/${newS3Key}`;
                                await Payout.findByIdAndUpdate(data.payoutId, {
                                    invoiceS3Key: newS3Key,
                                    invoiceUrl,
                                });
                            } catch (payoutUpdateErr) {
                                console.error('[AdminEmail] Failed to update Payout document with invoiceUrl:', payoutUpdateErr.message);
                            }
                        }
                    } catch (s3Err) {
                        console.error('[AdminEmail] AWS S3 PDF save warning:', s3Err.message || s3Err);
                    }
                }
            }

            if (pdfBuffer) {
                attachments.push({
                    filename: `Tax_Invoice_${data.payoutMonth || 'Settlement'}.pdf`,
                    content: pdfBuffer,
                });
            }
        } catch (pdfErr) {
            console.error('[AdminEmail] PDF processing error:', pdfErr);
        }
    }

    const sent = await sendEmail(recipientEmail, subject, html, text, attachments);

    // Automatically record in EmailLog for admin audit & history tracking (skip OTPs)
    try {
        const EmailLog = (await import('../models/emailLog.model.js')).default;
        const User = (await import('../models/user.model.js')).default;
        let recipientUser = null;
        if (data.userId) {
            recipientUser = await User.findById(data.userId).select('_id contact email').lean();
        } else if (recipientEmail) {
            recipientUser = await User.findOne({ $or: [{ contact: recipientEmail }, { email: recipientEmail }] }).select('_id contact email').lean();
        }

        await EmailLog.create({
            adminId: data.adminId || null,
            adminEmail: data.adminEmail || (data.adminName ? `${data.adminName} (Admin)` : (data.adminId ? 'Admin' : 'System Automated')),
            recipientType: 'individual',
            recipientIds: recipientUser ? [recipientUser._id] : [],
            recipientCount: 1,
            successCount: sent ? 1 : 0,
            failCount: sent ? 0 : 1,
            status: sent ? 'success' : 'failed',
            subject: (subject || '').trim(),
            body: text || html || '',
            bodyPreview: (text || html || '').substring(0, 500),
            templateId: templateName,
            template: {
                name: templateName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()),
                category: 'Admin Notification'
            },
            sentAt: new Date()
        });
    } catch (logErr) {
        console.error('[EMAIL_LOG_AUTO_SAVE_ERROR]', logErr.message);
    }

    return sent;
}

/**
 * Send a free-form email (custom template wrapper).
 */
export async function sendCustomEmail(recipientEmail, subject, body, creatorName, adminName) {
    return sendAdminEmail('custom', recipientEmail, { creatorName, subject, body, adminName });
}

export default { sendAdminEmail, sendCustomEmail, QUICK_TEMPLATES };
