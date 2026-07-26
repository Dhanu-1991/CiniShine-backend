import { saveOtp } from './services/otpStore.js';
import { sendOtpToEmail } from './services/otpServiceEmail.js';
import { sendOtpToPhone } from './services/otpServicePhone.js';

const sendOtp_forgotPass = async (req, res) => {
  const { contact, type } = req.body;

  if (!contact || !['email', 'phone'].includes(type)) {
    return res.status(400).json({ message: 'Invalid input' });
  }
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    saveOtp(contact, otp);

    if (type === 'email') {
      console.log("Sending OTP to email:", contact);
      const output = await sendOtpToEmail(contact, otp, 'forgotPassword');
      if (output === true) {
        return res.status(200).json({ success: true, message: 'OTP sent successfully. Valid for 5 minutes.' });
      }
      return res.status(500).json({ success: false, message: 'Failed to send OTP to email' });
    } else {
      console.log("Sending OTP to phone:", contact);
      const output = await sendOtpToPhone(contact, otp);
      if (output === true) {
        return res.status(200).json({ success: true, message: 'OTP sent successfully. Valid for 5 minutes.' });
      }
      return res.status(500).json({ message: 'Failed to send OTP to phone' });
    }
  } catch (err) {
    if (err.statusCode === 429) {
      return res.status(429).json({ message: err.message, retryAfterSec: err.retryAfterSec });
    }
    console.error(err);
    res.status(500).json({ message: 'Failed to send OTP' });
  }

};
export { sendOtp_forgotPass };
