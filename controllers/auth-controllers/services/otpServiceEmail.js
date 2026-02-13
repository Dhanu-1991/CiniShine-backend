import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();


const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendOtpToEmail(to, otp) {
  try {
    const info = await transporter.sendMail({
      from: `${process.env.EMAIL_NAME || 'CiniShine'} <${process.env.EMAIL_USER}>`,
      to,
      subject: 'Your OTP Code',
      text: `Your OTP code is ${otp}. It will expire in 5 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your OTP code is <strong>${otp}</strong>.</p><p>This code will expire in 5 minutes.</p><p>If you did not request this, please ignore this email.</p>`,
    });

    console.log('OTP email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Nodemailer error sending OTP:', error);
    return false;
  }
}
