import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const ses = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendEmail() {
    // Use Resend if configured
    if (resend) {
        try {
            const response = await resend.emails.send({
                from: process.env.EMAIL_USER || "admin@watchinit.com",
                to: "dhanushkumarvr@gmail.com",
                subject: "Your OTP Code",
                html: "<h1>Your OTP is 983425</h1>",
            });

            console.log("Resend response:", response);
            return;
        } catch (err) {
            console.error("Resend error:", err);
            // fallthrough to SES
        }
    }

    // Fallback to SES
    try {
        const params = {
            Destination: { ToAddresses: ["dhanushkumarvr@gmail.com"] },
            Message: {
                Body: {
                    Html: { Charset: "UTF-8", Data: "<h1>OTP IS 983425!</h1>" },
                    Text: { Charset: "UTF-8", Data: "Your one-time password is 983425." },
                },
                Subject: { Charset: "UTF-8", Data: "Verification Email from Watchinit" },
            },
            Source: process.env.EMAIL_USER || "admin@watchinit.com",
        };

        const result = await ses.send(new SendEmailCommand(params));
        console.log("SES response:", result);
    } catch (error) {
        console.error("SES error:", error);
    }
}

sendEmail();
