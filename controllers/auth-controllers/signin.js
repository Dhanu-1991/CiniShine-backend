import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
import { setAuthCookies } from "./services/cookieHelper.js";
import { sendSigninAlertEmail } from "../../services/authEmailService.js";
dotenv.config();

const signIn = async (req, res, next) => {
  try {
    const { contact, password } = req.body;

    // Case-insensitive contact lookup — escape regex special chars for safety
    const escapedContact = contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({ contact: { $regex: new RegExp(`^${escapedContact}$`, 'i') } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // 3. Track login time
    const loginTime = new Date();
    user.lastLoginAt = loginTime;
    await user.save();

    // 4. Set httpOnly auth cookies
    const { accessToken, refreshToken } = setAuthCookies(res, user);

    // 5. Send sign-in security alert email (non-blocking)
    const userEmail = user.email || (user.contact && user.contact.includes('@') ? user.contact : null);
    if (userEmail) {
      const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';

      sendSigninAlertEmail({
        email: userEmail,
        userName: user.userName,
        ipAddress,
        userAgent,
        signinTime: loginTime,
        method: 'Email & Password'
      }).catch(err => {
        console.error('[SIGNIN] Sign-in alert email error:', err.message);
      });
    }

    return res.status(200).json({
      success: true,
      message: "Signin successful",
      accessToken,
      refreshToken,
      user,
    });

  } catch (error) {
    console.error("SignIn Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

export { signIn };
