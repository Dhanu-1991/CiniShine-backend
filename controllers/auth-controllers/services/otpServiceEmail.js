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
    return false;}
  }
//     to: phone,
//   });
// }
// export { sendOtpToEmail, sendOtpToPhone };