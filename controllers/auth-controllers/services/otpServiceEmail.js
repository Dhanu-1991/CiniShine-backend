import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "Watchinit";

const ses = new SESClient({ region: REGION });
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * Builds professional, context-aware HTML & plain text email content based on purpose.
 */
export function getOtpEmailContent(otp, purposeInput = 'default') {
  const rawPurpose = (typeof purposeInput === 'object' ? purposeInput?.purpose : purposeInput) || 'default';
  const purpose = String(rawPurpose).trim();

  const purposeMap = {
    signup: {
      title: "Account Registration Verification",
      subject: `[${PLATFORM_NAME}] Verify Your Email - Account Registration`,
      heading: "Welcome to " + PLATFORM_NAME + "!",
      message: "Thank you for starting your registration. Please use the One-Time Password (OTP) below to verify your email address and complete your account setup:",
      badgeColor: "#4f46e5",
      headerGradient: "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)",
    },
    adminSignup: {
      title: "Admin Account Registration",
      subject: `[${PLATFORM_NAME}] Admin Registration Verification Code`,
      heading: "Admin Portal Registration",
      message: "An admin account setup request was initiated for your email. Use the One-Time Password (OTP) below to complete your registration request:",
      badgeColor: "#4f46e5",
      headerGradient: "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)",
    },
    forgotPassword: {
      title: "Password Reset Request",
      subject: `[${PLATFORM_NAME}] Password Reset Verification Code`,
      heading: "Reset Your Password",
      message: "We received a request to reset the password for your " + PLATFORM_NAME + " account. Use the verification code below to authorize this request:",
      badgeColor: "#e11d48",
      headerGradient: "linear-gradient(135deg, #e11d48 0%, #9f1239 100%)",
    },
    forgot_password: {
      title: "Password Reset Request",
      subject: `[${PLATFORM_NAME}] Password Reset Verification Code`,
      heading: "Reset Your Password",
      message: "We received a request to reset the password for your " + PLATFORM_NAME + " account. Use the verification code below to authorize this request:",
      badgeColor: "#e11d48",
      headerGradient: "linear-gradient(135deg, #e11d48 0%, #9f1239 100%)",
    },
    kyc_update: {
      title: "KYC & Account Verification",
      subject: `[${PLATFORM_NAME}] Verification Required - KYC & Account Details Update`,
      heading: "Security Verification",
      message: "A request has been made to update your KYC documents or settlement bank details on " + PLATFORM_NAME + ". Please use the One-Time Password (OTP) below to authorize this update:",
      badgeColor: "#0284c7",
      headerGradient: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
    },
    kycUpdate: {
      title: "KYC & Account Verification",
      subject: `[${PLATFORM_NAME}] Verification Required - KYC & Account Details Update`,
      heading: "Security Verification",
      message: "A request has been made to update your KYC documents or settlement bank details on " + PLATFORM_NAME + ". Please use the One-Time Password (OTP) below to authorize this update:",
      badgeColor: "#0284c7",
      headerGradient: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
    },
    account_update: {
      title: "Account Profile Update",
      subject: `[${PLATFORM_NAME}] Security Code - Account Update Verification`,
      heading: "Confirm Profile Changes",
      message: "A request was made to modify your profile settings or sensitive account information. Enter the verification code below to confirm and apply these changes:",
      badgeColor: "#0284c7",
      headerGradient: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
    },
    payout: {
      title: "Payout Authorization",
      subject: `[${PLATFORM_NAME}] Action Required - Payout Authorization OTP`,
      heading: "Authorize Payout Transaction",
      message: "A request to initiate or process a payout transfer was submitted. Please use the verification code below to confirm and authorize the payout release:",
      badgeColor: "#059669",
      headerGradient: "linear-gradient(135deg, #059669 0%, #047857 100%)",
    },
    bulk_payout: {
      title: "Bulk Payout Security Verification",
      subject: `[${PLATFORM_NAME}] Action Required - Bulk Payout Security Code`,
      heading: "Bulk Payout Authorization",
      message: "An administrative request for batch payout processing was initiated. Use the One-Time Password (OTP) below to confirm and authorize payout execution:",
      badgeColor: "#059669",
      headerGradient: "linear-gradient(135deg, #059669 0%, #047857 100%)",
    },
    admin_login: {
      title: "Admin Portal Security Code",
      subject: `[${PLATFORM_NAME}] Security Code - Admin Access Authentication`,
      heading: "Admin Portal Authentication",
      message: "A sign-in attempt to the Admin Portal was detected. Use the Two-Factor Authentication (2FA) code below to verify your identity:",
      badgeColor: "#7c3aed",
      headerGradient: "linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)",
    },
    adminLogin: {
      title: "Admin Portal Security Code",
      subject: `[${PLATFORM_NAME}] Security Code - Admin Access Authentication`,
      heading: "Admin Portal Authentication",
      message: "A sign-in attempt to the Admin Portal was detected. Use the Two-Factor Authentication (2FA) code below to verify your identity:",
      badgeColor: "#7c3aed",
      headerGradient: "linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)",
    },
    default: {
      title: "Security Verification Code",
      subject: `[${PLATFORM_NAME}] Security Verification Code (OTP)`,
      heading: "Security Verification",
      message: "Please use the One-Time Password (OTP) below to proceed with your verification request:",
      badgeColor: "#4f46e5",
      headerGradient: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
    }
  };

  const config = purposeMap[purpose] || purposeMap.default;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="600" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: ${config.headerGradient}; padding: 32px 40px; text-align: left;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">${PLATFORM_NAME}</h1>
              <p style="margin: 6px 0 0 0; color: rgba(255, 255, 255, 0.85); font-size: 14px; font-weight: 400;">${config.title}</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 40px; color: #334155; font-size: 15px; line-height: 1.6;">
              <h2 style="margin-top: 0; color: #0f172a; font-size: 20px; font-weight: 600;">${config.heading}</h2>
              <p style="margin-bottom: 24px;">${config.message}</p>
              
              <!-- OTP Box -->
              <div style="text-align: center; margin: 32px 0;">
                <div style="display: inline-block; background-color: #f8fafc; border: 2px dashed ${config.badgeColor}; border-radius: 12px; padding: 18px 36px; text-align: center;">
                  <span style="display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #64748b; font-weight: 600; margin-bottom: 6px;">Verification Code</span>
                  <span style="font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: ${config.badgeColor};">${otp}</span>
                </div>
              </div>

              <!-- Security Notice -->
              <div style="background-color: #f8fafc; border-left: 4px solid ${config.badgeColor}; padding: 16px 20px; border-radius: 6px; margin: 28px 0 20px 0;">
                <p style="margin: 0; font-size: 13px; color: #475569; line-height: 1.5;">
                  <strong>🔒 Security Note:</strong> This code is valid for <strong>5 minutes</strong>. For your protection, never share this OTP with anyone. Our support team will never ask for your verification code.
                </p>
              </div>

              <p style="margin-top: 24px; color: #64748b; font-size: 13px;">If you did not request this verification code, no action is required. You can safely disregard this email.</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 12px;">
              <p style="margin: 0 0 6px 0;">This is an automated operational notification from ${PLATFORM_NAME}.</p>
              <p style="margin: 0;">&copy; ${new Date().getFullYear()} ${PLATFORM_NAME}. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${PLATFORM_NAME} - ${config.title}\n\n${config.heading}\n\n${config.message}\n\nYour Verification Code: ${otp}\n\nThis code expires in 5 minutes. Do not share this code with anyone.\n\nIf you did not request this code, please ignore this email.\n\n© ${new Date().getFullYear()} ${PLATFORM_NAME}`;

  return {
    subject: config.subject,
    html,
    text
  };
}

export async function sendOtpToEmail(to, otp, purpose = 'default') {
  const { subject, html, text } = getOtpEmailContent(otp, purpose);

  // Prefer Resend if API key provided
  if (resendClient) {
    try {
      const resp = await resendClient.emails.send({
        from: process.env.RESEND_FROM || FROM_ADDRESS,
        to,
        subject,
        html,
        text,
      });

      console.log("Resend response:", resp);
      // Resend returns shape { data: { id: '...' } } on success
      const succeeded = Boolean(resp && (resp.id || resp.messageId || resp.data?.id));
      if (succeeded) return true;
      // If Resend responded but without id, treat as failure and don't silently fallback to SES
      console.error('Resend did not return an id, response:', resp);
    } catch (err) {
      console.error("Resend error:", err);
      if (err?.message?.includes('domain is not verified') || err?.message?.includes('validation_error')) {
        console.error('Resend validation error — verify your sending domain at https://resend.com/domains and set RESEND_FROM to a verified domain.');
        // Do not attempt SES fallback when resend failed due to domain verification — return false
        return false;
      }
      // For other errors, fallthrough to SES fallback
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

    console.log("Sending SES email to:", to);

    const command = new SendEmailCommand(params);
    const response = await ses.send(command);

    console.log("SES response:", response);
    if (!response || !response.MessageId) {
      console.error("SES failed to send email");
      return false;
    }

    return true;
  } catch (error) {
    console.error("SES error:", error);
    return false;
  }
}

