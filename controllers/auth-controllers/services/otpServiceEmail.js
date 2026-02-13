import SibApiV3Sdk from 'sib-api-v3-sdk';
import dotenv from "dotenv";
dotenv.config();


const client = SibApiV3Sdk.ApiClient.instance;
client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

export async function sendOtpToEmail(to, otp) {
  try {
    await apiInstance.sendTransacEmail({
      sender: { email: process.env.EMAIL_USER, name: "CiniShine" },
      to: [{ email: to }],
      subject: "Your OTP Code",
      textContent: `Your OTP is ${otp}`
    });

    console.log("OTP sent successfully");
    return true;
  } catch (error) {
    console.error("Brevo error:", error.response?.body || error);
    return false;
  }
}
