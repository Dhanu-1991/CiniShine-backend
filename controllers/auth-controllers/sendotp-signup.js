//sendOtp
import { saveOtp } from './services/otpStore.js'
import { sendOtpToEmail } from './services/otpServiceEmail.js'; // You must implement these functions
import { sendOtpToPhone } from './services/otpServicePhone.js'; // You must implement these functions
import { validateEmailAddress } from './validate.email.js'; // You must implement this function
import { detectCommonEmailTypos } from './validate.email.js';
const sendOtp_signup = async (req, res) => {

  const { contact, type } = req.body;

  if (!contact || !['email', 'phone'].includes(type)) {
    return res.status(400).json({ message: 'Invalid input' });
  }
  
  if (type === 'email') {
    const typoResult = detectCommonEmailTypos(contact);
    if (typoResult && typoResult.isTypo) {
      console.log("Suggested email correction:", typoResult.suggestion);
      return res.status(400).json({
        message: `Typo in your email address. Please correct it and try again.`,
        suggestion: typoResult.suggestion
      });
    }
    const emailValidationResult = await validateEmailAddress(contact);
    if (!emailValidationResult.valid) {
      return res.status(400).json({ message: 'Invalid email address' });
    }
  }
  // Generate OTP

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  saveOtp(contact, otp);

  try {
    // Send OTP
    if (type === 'email') {
        console.log("Sending OTP to email:", contact);
      const output=await sendOtpToEmail
      (contact, otp);
      if(output===true){
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
export { sendOtp_signup };