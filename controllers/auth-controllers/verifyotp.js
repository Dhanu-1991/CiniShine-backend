import { getOtp, deleteOtp, markVerified } from './services/otpStore.js';

const verifyOtp = async (req, res) => {
    const { contact, otp } = req.body;

    if (!contact || !otp) {
        return res.status(400).json({ success: false, message: 'Contact and OTP are required' });
    }

    const actualOtp = getOtp(contact);

    if (!actualOtp) {
        return res.status(400).json({ success: false, message: 'OTP has expired or was not requested' });
    }

    if (actualOtp === String(otp).trim()) {
        deleteOtp(contact);
        markVerified(contact);
        return res.status(200).json({ success: true, message: 'OTP verified successfully' });
    }

    return res.status(400).json({ success: false, message: 'Invalid OTP' });
};

export { verifyOtp };
