import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const PROMAILER_ENDPOINT = process.env.PROMAILER_URL || "https://mailserver.automationlounge.com/api/v1/messages/send";

export async function sendOtpToEmail(to, otp) {
  try {
    const payload = {
      to: to,
      subject: "Your OTP Code",
      html: `<h2>Your OTP</h2><p>Your OTP is <b>${otp}</b></p>`,
    };

    // optional plain-text
    payload.text = `Your OTP is ${otp}`;

    // optional custom sender if you set PROMAILER_FROM in .env
    if (process.env.PROMAILER_FROM) payload.from = process.env.PROMAILER_FROM;

    console.log("Sending payload:", payload);

    const response = await axios.post(PROMAILER_ENDPOINT, payload, {
      headers: {
        Authorization: `Bearer ${process.env.PROMAILER_API_KEY}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true, // we'll handle non-2xx manually to log body
    });

    console.log("Promailer status:", response.status);
    console.log("Promailer response:", response.data);

    if (!response.data || response.data.success !== true) {
      console.error('Promailer rejected request');
      return false;
    }

    return true;
  } catch (error) {
    console.error("Promailer error:", error.response?.data || error.message);
    return false;
  }
}
