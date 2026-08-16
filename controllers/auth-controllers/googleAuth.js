import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import User from "../../models/user.model.js";
import { setAuthCookies } from "./services/cookieHelper.js";
import { ensurePrimaryWallet } from "../../utils/walletService.js";
import { processReferralSignup } from '../../utils/referralService.js';
import { sendWelcomeEmail, sendSigninAlertEmail } from '../../services/authEmailService.js';

let googleClient = null;
let googleClientInitError = null;

const getGoogleClient = async () => {
  if (googleClient) return googleClient;
  if (googleClientInitError) throw googleClientInitError;

  try {
    const { OAuth2Client } = await import("google-auth-library");
    googleClient = new OAuth2Client();
    return googleClient;
  } catch (error) {
    googleClientInitError = error;
    throw error;
  }
};

const sanitizeUser = (userDoc) => {
  const { password, __v, ...safeUser } = userDoc.toObject();
  return safeUser;
};

const getFallbackUserName = (email, nameFromGoogle) => {
  if (nameFromGoogle && nameFromGoogle.trim()) {
    return nameFromGoogle.trim().slice(0, 60);
  }

  const localPart = email.split("@")[0] || "watchinit_user";
  return localPart.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60) || "watchinit_user";
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const verifyGoogleToken = async (credential) => {
  const client = await getGoogleClient();
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  return ticket.getPayload();
};

const googleAuth = async (req, res) => {
  try {
    const { credential, referralCode } = req.body;

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        success: false,
        message: "Google auth is not configured on the server",
      });
    }

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Google credential is required",
      });
    }

    let payload;
    try {
      payload = await verifyGoogleToken(credential);
    } catch (error) {
      if (
        error?.code === "ERR_MODULE_NOT_FOUND" ||
        String(error?.message || "").includes("google-auth-library")
      ) {
        // Reset so next attempt will retry the import
        googleClientInitError = null;
        googleClient = null;
        return res.status(503).json({
          success: false,
          message: "Google auth is temporarily unavailable",
        });
      }

      return res.status(401).json({
        success: false,
        message: "Invalid Google credential",
      });
    }

    if (!payload?.email || !payload?.email_verified) {
      return res.status(401).json({
        success: false,
        message: "Google account email is missing or not verified",
      });
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase().trim();
    const emailRegex = new RegExp(`^${escapeRegex(email)}$`, "i");
    const profilePicture = payload.picture || null;
    const fullName = payload.name?.trim() || "";

    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ contact: emailRegex });
    }

    if (user) {
      if (user.googleId && user.googleId !== googleId) {
        return res.status(409).json({
          success: false,
          message: "Google account does not match this user",
        });
      }

      // Link Google info if not already set
      if (!user.googleId) user.googleId = googleId;
      if (!user.fullName && fullName) user.fullName = fullName;
      if (!user.userName && fullName) user.userName = fullName;

      // Always sync Google profile picture if the stored one is from Google
      // (external URL) OR if there is no picture yet.
      // Do NOT overwrite a picture the user manually uploaded to S3/CF.
      const currentPic = user.profilePicture || '';
      const currentPicIsExternal =
        currentPic.startsWith('http') && !currentPic.includes('.amazonaws.com') && !currentPic.includes('cloudfront.net');
      if (profilePicture && (!currentPic || currentPicIsExternal)) {
        user.profilePicture = profilePicture;
      }

      // Mark as Google-linked if not already
      if (user.authProvider !== 'google') user.authProvider = 'google';
      user.emailVerified = true;
      const loginTime = new Date();
      user.lastLoginAt = loginTime;
      await user.save();

      // Send sign-in security alert email (non-blocking)
      const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';
      sendSigninAlertEmail({
        email,
        userName: user.userName || user.fullName,
        ipAddress,
        userAgent,
        signinTime: loginTime,
        method: 'Google Sign-In'
      }).catch(err => {
        console.error('[GOOGLE_AUTH] Sign-in alert email error:', err.message);
      });
    } else {
      const randomPassword = crypto.randomBytes(48).toString("hex");
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      user = await User.create({
        contact: email,
        userName: getFallbackUserName(email, fullName),
        fullName: fullName || undefined,
        password: hashedPassword,
        profilePicture: profilePicture || undefined,
        googleId,
        authProvider: "google",
        emailVerified: true,
        lastLoginAt: new Date(),
      });

      // Send welcome email for new Google user (non-blocking)
      sendWelcomeEmail({
        email,
        userName: user.userName || user.fullName
      }).catch(err => {
        console.error('[GOOGLE_AUTH] Welcome email error:', err.message);
      });

      // Create primary wallet for new user (fire-and-forget, non-blocking)
      ensurePrimaryWallet(user._id).catch(err => console.error('Wallet creation error:', err));

      if (referralCode) {
          processReferralSignup(referralCode, user._id).catch(err => {
              console.error('[GOOGLE_AUTH] Referral processing error:', err.message);
          });
      }
    }

    // Set httpOnly auth cookies
    const { accessToken, refreshToken } = setAuthCookies(res, user);

    return res.status(200).json({
      success: true,
      message: "Google authentication successful",
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
      data: {
        authProvider: "google",
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

export { googleAuth };
