import Mailjet from "node-mailjet";
import dotenv from "dotenv";

dotenv.config();

// initialize SDK
const mailjet = Mailjet.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_API_SECRET
);

async function sendEmail() {
    try {
        const request = mailjet
            .post("send", { version: "v3.1" })
            .request({
                Messages: [
                    {
                        From: {
                            Email: "dhanushkumarvr019@gmail.com",
                            Name: "Cini Shine",
                        },
                        To: [
                            {
                                Email: "dhanushkumarvr@gmail.com",
                                Name: "Dhanush Kumar V R",
                            },
                        ],
                        Subject: "Verification Email from Cini Shine",
                        TextPart: "Your one-time password is 983425.",
                        HTMLPart: "<h1>OTP IS 983425!</h1>",
                    },
                ],
            });

        const result = await request;
        console.log("Mailjet response:", result.body);
    } catch (error) {
        console.error("Mailjet error:", error.statusCode, error.body);
    }
}

sendEmail();
