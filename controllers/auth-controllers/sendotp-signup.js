//sendOtp — unified for signup and forgot-password
import { saveOtp } from './services/otpStore.js'
import { sendOtpToEmail } from './services/otpServiceEmail.js';
import { sendOtpToPhone } from './services/otpServicePhone.js';
import { detectCommonEmailTypos } from './validate.email.js';

const sendOtp = async (req, res) => {
  const { contact, type, purpose } = req.body;

  if (!contact || !['email', 'phone'].includes(type)) {
    return res.status(400).json({ message: 'Invalid input' });
  }

  // Email typo detection — only for signup flow
  if (type === 'email' && purpose !== 'forgotPassword') {
    const typoResult = detectCommonEmailTypos(contact);
    if (typoResult && typoResult.isTypo) {
      console.log("Suggested email correction:", typoResult.suggestion);
      return res.status(400).json({
        message: `Typo in your email address. Please correct it and try again.`,
        suggestion: typoResult.suggestion
      });
    }
    //Enable this when you have money to spend on email validation API
    // const emailValidationResult = await validateEmailAddress(contact);
    // if (!emailValidationResult.valid) {
    //   return res.status(400).json({ message: 'Invalid email address' });
    // }
  }
  // Generates a random 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  saveOtp(contact, otp);


  try {
    // Send OTP
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
export { sendOtp };