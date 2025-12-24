//import nodemailer from 'nodemailer';
import { Resend } from "resend";
// import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendOtpToEmail(email, otp) {
  try {
    await resend.emails.send({
      from: `"CiniShine" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your OTP Code',
      html: `<h2>Your OTP is <b>${otp}</b></h2>`,
    });

    console.log('Email sent via Resend');
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// // Twilio setup
// const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// async function sendOtpToPhone(phone, otp) {
//   await client.messages.create({
//     body: `Your OTP is ${otp}`,
//     from: '+1234567890', // Your Twilio number
//     to: phone,
//   });
// }
// export { sendOtpToEmail, sendOtpToPhone };
