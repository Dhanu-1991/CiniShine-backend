import nodemailer from 'nodemailer';
// import twilio from 'twilio';
import dotenv from 'dotenv';
dotenv.config();
 export async function sendOtpToEmail(email, otp) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"CiniShine" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your OTP Code',
    text: `Your OTP is ${otp}`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info);
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