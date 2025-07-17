// services/sendOtpToPhone.js
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export async function sendOtpToPhone(phoneNumber, otp) {
  const API_KEY = process.env.FAST2SMS_API_KEY;
  const TEMPLATE_ID = 2626;

  try {
    const url = `https://www.fast2sms.com/dev/whatsapp?authorization=${API_KEY}&message_id=${TEMPLATE_ID}&numbers=${phoneNumber}&variables_values=${otp}`;

    const response = await axios.get(url);

    if (response.data.return === true) {
      console.log("OTP sent successfully via WhatsApp");
      return true;
    } else {
      console.error("Error response from Fast2SMS:", response.data);
      return false;
    }
  } catch (err) {
    console.error("Failed to send OTP via WhatsApp:", err.message || err);
    return false;
  }
}