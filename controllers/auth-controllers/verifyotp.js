import { getOtp, deleteOtp } from './services/otpStore.js';
const verifyOtp = async (req, res) => {

    const {contact,otp} = req.body;
    const actualOtp=getOtp(contact);
    if(actualOtp===otp){
        console.log("otp matched")
        deleteOtp(contact);
        console.log("deleted stored otp")
        return res.status(200).json({ message: 'OTP verified successfully' });
    }
    if(actualOtp!==otp){
        console.log("otps didnt match")
        return res.status(299).json({ message: 'Invalid OTP' });
    
    }

    return res.status(500).json({message:"some error in veryfying Otp"});
}
export {verifyOtp};
