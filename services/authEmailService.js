/**
 * Auth Email Service
 * Handles transactional emails for user authentication:
 *  - Welcome email upon new user registration (standard signup & Google auth)
 *  - Security notification email on every sign-in with IP, device, and timestamp
 *
 * Utilizes Resend (primary) with AWS SES fallback.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "WATCHIN IT";
const PLATFORM_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || "https://watchinit.com";

const ses = new SESClient({ region: REGION });
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * Format user-agent string into human-readable device/browser summary
 */
function parseDeviceSummary(userAgent = "") {
    if (!userAgent) return "Unknown Device";
    
    let browser = "Web Browser";
    if (userAgent.includes("Edg/")) browser = "Microsoft Edge";
    else if (userAgent.includes("Chrome/")) browser = "Google Chrome";
    else if (userAgent.includes("Safari/") && !userAgent.includes("Chrome/")) browser = "Apple Safari";
    else if (userAgent.includes("Firefox/")) browser = "Mozilla Firefox";
    else if (userAgent.includes("PostmanRuntime")) browser = "Postman / API Client";

    let os = "Desktop";
    if (userAgent.includes("Windows")) os = "Windows";
    else if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS")) os = "macOS";
    else if (userAgent.includes("iPhone")) os = "iPhone (iOS)";
    else if (userAgent.includes("iPad")) os = "iPad (iPadOS)";
    else if (userAgent.includes("Android")) os = "Android";
    else if (userAgent.includes("Linux")) os = "Linux";

    return `${browser} on ${os}`;
}

/**
 * Clean up IP address (handle local IPv6, proxies)
 */
function cleanIp(ip) {
    if (!ip) return "Unknown IP";
    if (ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1") return "127.0.0.1 (Localhost)";
    return ip.replace(/^::ffff:/, '').trim();
}

/**
 * Core email sender using Resend with SES fallback
 */
async function sendEmailCore({ to, subject, html, text }) {
    if (!to || !to.includes("@")) {
        console.warn("[AuthEmail] Invalid recipient email address:", to);
        return false;
    }

    // 1. Prefer Resend
    if (resendClient) {
        try {
            const resp = await resendClient.emails.send({
                from: process.env.RESEND_FROM || FROM_ADDRESS,
                to,
                subject,
                html,
                text,
            });

            const succeeded = Boolean(resp && (resp.id || resp.messageId || resp.data?.id));
            if (succeeded) {
                console.log(`[AuthEmail] Email delivered via Resend to ${to} (${subject})`);
                return true;
            }
            console.error('[AuthEmail] Resend response without message ID:', resp);
        } catch (err) {
            console.error("[AuthEmail] Resend error:", err.message);
            if (err?.message?.includes('domain is not verified') || err?.message?.includes('validation_error')) {
                return false;
            }
        }
    }

    // 2. Fallback to AWS SES
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
            console.log(`[AuthEmail] Email delivered via AWS SES to ${to} (${subject})`);
            return true;
        }
        console.error("[AuthEmail] SES failed to return MessageId");
        return false;
    } catch (err) {
        console.error("[AuthEmail] SES error:", err.message);
        return false;
    }
}

/**
 * Send Welcome Email to a newly registered user
 * @param {Object} params
 * @param {string} params.email - User's email
 * @param {string} [params.userName] - Display or username
 */
export async function sendWelcomeEmail({ email, userName }) {
    try {
        if (!email || !email.includes('@')) return;

        const displayName = userName ? userName.trim() : 'Friend';
        const subject = "Welcome to Watchin It — House of Cinema 🎬";

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #e2e8f0;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="600" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #111827; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1); border: 1px solid #e2e8f0;">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%); padding: 36px 40px; text-align: left; border-bottom: 1px solid rgba(255, 255, 255, 0.1);">
              <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">WATCHIN IT</h1>
              <p style="margin: 6px 0 0 0; color: #a5b4fc; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">House of Cinema</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 40px 40px 32px 40px; color: #cbd5e1; font-size: 15px; line-height: 1.7;">
              <p style="margin-top: 0; font-size: 16px; color: #f8fafc;">Hi <strong>${displayName}</strong>,</p>
              
              <p style="color: #f1f5f9; font-size: 17px; font-weight: 600; margin: 16px 0;">
                Welcome to WATCHIN IT, House of Cinema.
              </p>
              
              <p style="color: #94a3b8; margin-bottom: 24px;">
                You've just joined a platform built for people who are tired of watching the same faces and the same stories on repeat. Whether you're here to discover fresh talent or showcase your own work, you're now part of a community built around real cinema, real creators, and real discovery.
              </p>

              <!-- What to do next section -->
              <div style="background-color: #0b0f19; border-radius: 12px; padding: 24px; margin: 24px 0; border: 1px solid #1f2937;">
                <p style="margin: 0 0 16px 0; color: #818cf8; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;">
                  Here's what you can do next:
                </p>
                
                <ul style="margin: 0; padding-left: 20px; color: #e2e8f0; font-size: 14px; line-height: 1.8;">
                  <li style="margin-bottom: 10px;">Complete your profile so we can start personalising your feed</li>
                  <li style="margin-bottom: 10px;">Explore content from creators you won't find anywhere else</li>
                  <li style="margin-bottom: 0;">If you're a creator, start building your presence and unlock monetization through rentals, subscriptions, and engagement earnings</li>
                </ul>
              </div>

              <!-- CTA -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="${PLATFORM_URL}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 34px; border-radius: 8px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);">
                  Explore Watchin It →
                </a>
              </div>

              <div style="margin-top: 24px; border-top: 1px solid #1f2937; padding-top: 20px;">
                <p style="margin: 0; color: #f8fafc; font-weight: 600;">Welcome aboard.</p>
                <p style="margin: 4px 0 0 0; color: #818cf8; font-weight: 700; letter-spacing: 0.5px;">WATCHINIT</p>
                <p style="margin: 2px 0 0 0; color: #64748b; font-size: 13px;">House of Cinema</p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0b0f19; padding: 20px 40px; border-top: 1px solid #1f2937; text-align: center; color: #475569; font-size: 12px;">
              <p style="margin: 0 0 4px 0;">This email was sent to ${email} because an account was registered with WATCHINIT.</p>
              <p style="margin: 0;">&copy; ${new Date().getFullYear()} WATCHINIT. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

        const text = `Hi ${displayName},

Welcome to WATCHIN IT, House of Cinema.

You've just joined a platform built for people who are tired of watching the same faces and the same stories on repeat. Whether you're here to discover fresh talent or showcase your own work, you're now part of a community built around real cinema, real creators, and real discovery.

Here's what you can do next:

Complete your profile so we can start personalising your feed
Explore content from creators you won't find anywhere else
If you're a creator, start building your presence and unlock monetization through rentals, subscriptions, and engagement earnings

Welcome aboard.
WATCHINIT
House of Cinema`;

        return await sendEmailCore({ to: email, subject, html, text });
    } catch (err) {
        console.error("[AuthEmail] Error sending welcome email:", err.message);
        return false;
    }
}

/**
 * Send Sign-in Security Notification Email
 * @param {Object} params
 * @param {string} params.email - User's email
 * @param {string} [params.userName] - Display or username
 * @param {string} [params.ipAddress] - Client IP address
 * @param {string} [params.userAgent] - Client User Agent string
 * @param {Date}   [params.signinTime] - Time of signin
 * @param {string} [params.method] - Signin method ('Password', 'Google Sign-In', etc.)
 */
export async function sendSigninAlertEmail({
    email,
    userName,
    ipAddress = '',
    userAgent = '',
    signinTime = new Date(),
    method = 'Password'
}) {
    try {
        if (!email || !email.includes('@')) return;

        const displayName = userName ? userName.trim() : 'User';
        const formattedDate = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'full',
            timeStyle: 'medium',
            timeZone: 'Asia/Kolkata' // Indian Standard Time
        }).format(signinTime);

        const utcDate = signinTime.toUTCString();
        const deviceSummary = parseDeviceSummary(userAgent);
        const displayIp = cleanIp(ipAddress);
        const subject = `[WATCHIN IT] Security Alert: New Sign-in to Your Account`;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #e2e8f0;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="600" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #0f172a; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); border: 1px solid #cbd5e1;">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 30px 40px; text-align: left; border-bottom: 2px solid #3b82f6;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">WATCHIN IT</h1>
              <p style="margin: 4px 0 0 0; color: #94a3b8; font-size: 13px; font-weight: 500;">Account Security Notification</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 36px 40px; background-color: #0f172a; color: #cbd5e1; font-size: 15px; line-height: 1.6;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 18px;">
                <span style="font-size: 22px;">🔐</span>
                <h2 style="margin: 0; color: #f8fafc; font-size: 19px; font-weight: 600;">New Sign-in Detected</h2>
              </div>
              
              <p style="margin-bottom: 20px; color: #94a3b8;">
                Hi <strong>${displayName}</strong>, we detected a successful sign-in to your <strong>WATCHIN IT</strong> account.
              </p>

              <!-- Details Card -->
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #0b1120; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b; margin: 20px 0;">
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1e293b; color: #64748b; font-size: 13px; width: 130px; font-weight: 600;">Time:</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1e293b; color: #f1f5f9; font-size: 13px; font-weight: 500;">
                    ${formattedDate} <span style="color: #64748b; font-size: 11px;">(IST)</span><br/>
                    <span style="color: #64748b; font-size: 12px;">${utcDate}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1e293b; color: #64748b; font-size: 13px; font-weight: 600;">Device & Browser:</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1f2937; color: #f1f5f9; font-size: 13px; font-weight: 500;">
                    ${deviceSummary}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1e293b; color: #64748b; font-size: 13px; font-weight: 600;">IP Address:</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #1e293b; color: #f1f5f9; font-size: 13px; font-family: 'Courier New', monospace; font-weight: 600;">
                    ${displayIp}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; color: #64748b; font-size: 13px; font-weight: 600;">Sign-in Method:</td>
                  <td style="padding: 14px 20px; color: #38bdf8; font-size: 13px; font-weight: 600;">
                    ${method}
                  </td>
                </tr>
              </table>

              <!-- Security Warning -->
              <div style="background-color: rgba(239, 68, 68, 0.1); border-left: 4px solid #ef4444; padding: 16px 20px; border-radius: 6px; margin: 24px 0;">
                <p style="margin: 0 0 6px 0; font-size: 13px; color: #fca5a5; font-weight: 600;">
                  Don't recognize this activity?
                </p>
                <p style="margin: 0; font-size: 13px; color: #e2e8f0; line-height: 1.5;">
                  If this wasn't you, your account may be compromised. Please reset your password immediately and review your active sessions.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0b1120; padding: 24px 40px; border-top: 1px solid #1e293b; text-align: center; color: #64748b; font-size: 12px;">
              <p style="margin: 0 0 6px 0;">This is an automated security notification sent to ${email}.</p>
              <p style="margin: 0;">&copy; ${new Date().getFullYear()} WATCHIN IT. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

        const text = `WATCHIN IT Security Alert: New Sign-in

Hi ${displayName},

A new sign-in to your WATCHIN IT account was detected:
- Time: ${formattedDate} (${utcDate})
- Device: ${deviceSummary}
- IP: ${displayIp}
- Method: ${method}

If you did not initiate this sign-in, please reset your password immediately.

© ${new Date().getFullYear()} WATCHIN IT`;

        return await sendEmailCore({ to: email, subject, html, text });
    } catch (err) {
        console.error("[AuthEmail] Error sending signin alert email:", err.message);
        return false;
    }
}
