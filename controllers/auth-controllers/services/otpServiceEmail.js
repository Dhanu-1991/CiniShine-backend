import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";
const FROM_ADDRESS = process.env.EMAIL_USER || "no-reply@example.com";

const ses = new SESClient({ region: REGION });
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export async function sendOtpToEmail(to, otp) {
  // Prefer Resend if API key provided
  if (resendClient) {
    try {
      const resp = await resendClient.emails.send({
        from: FROM_ADDRESS,
        to,
        subject: "Your OTP Code",
        html: `<h2>Your OTP</h2><p>Your OTP is <b>${otp}</b></p>`,
      });

      console.log("Resend response:", resp);
      if (resp && (resp.id || resp.messageId)) return true;
    } catch (err) {
      console.error("Resend error:", err);
      // fallthrough to SES fallback
    }
  }

  // Fallback to AWS SES
  try {
    const params = {
      Destination: { ToAddresses: [to] },
      Message: {
        Body: {
          Html: { Charset: "UTF-8", Data: `<h2>Your OTP</h2><p>Your OTP is <b>${otp}</b></p>` },
          Text: { Charset: "UTF-8", Data: `Your OTP is ${otp}` },
        },
        Subject: { Charset: "UTF-8", Data: "Your OTP Code" },
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
