import { saveOtp } from './services/otpStore.js';
import { sendOtpToEmail } from './services/otpServiceEmail.js';
import { sendOtpToPhone } from './services/otpServicePhone.js';

const sendOtp_forgotPass = async (req, res) => {
  const { contact, type } = req.body;

  if (!contact || !['email', 'phone'].includes(type)) {
    return res.status(400).json({ message: 'Invalid input' });
  }
  // Generates a random 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  saveOtp(contact, otp);


  try {

    if (type === 'email') {
      console.log("Sending OTP to email:", contact);
      const output = await sendOtpToEmail
        (contact, otp);
      if (output === true) {
        return res.status(200).json({ message: 'OTP sent successfully' });
      }
      return res.status(500).json({ message: 'Failed to send OTP to email' });
    }

    else {
      console.log("Sending OTP to phone:", contact);
      const output = await sendOtpToPhone(contact, otp);
      if (output === true) {
        return res.status(200).json({ message: 'OTP sent successfully' });
      }
      return res.status(500).json({ message: 'Failed to send OTP to phone' });
    }
  }

  catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to send OTP' });
  }

};
export { sendOtp_forgotPass };
