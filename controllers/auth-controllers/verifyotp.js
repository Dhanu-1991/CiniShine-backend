import { getOtp, deleteOtp } from './services/otpStore.js';

const verifyOtp = async (req, res) => {
    const { contact, otp } = req.body;

    if (!contact || !otp) {
        return res.status(400).json({ message: 'Contact and OTP are required' });
    }

    const actualOtp = getOtp(contact);

    if (!actualOtp) {
        return res.status(400).json({ message: 'OTP has expired or was not requested' });
    }

    if (actualOtp === otp) {
        deleteOtp(contact);
        return res.status(200).json({ message: 'OTP verified successfully' });
    }

    return res.status(400).json({ message: 'Invalid OTP' });
};

export { verifyOtp };
