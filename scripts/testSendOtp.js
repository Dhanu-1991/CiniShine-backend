import dotenv from 'dotenv';
dotenv.config();

import { sendOtpToEmail } from '../controllers/auth-controllers/services/otpServiceEmail.js';

const email = 'dhanushkumarvr@gmail.com';
const otp = 'dummyotp';

(async () => {
    console.log('Sending OTP to', email);
    const ok = await sendOtpToEmail(email, otp);
    console.log('Result:', ok);
    process.exit(ok ? 0 : 1);
})();
