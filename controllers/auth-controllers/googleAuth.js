import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";

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
    const { credential } = req.body;

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

      if (!user.googleId) user.googleId = googleId;
      if (!user.fullName && fullName) user.fullName = fullName;
      if (!user.userName && fullName) user.userName = fullName;
      if (!user.profilePicture && profilePicture) user.profilePicture = profilePicture;
      user.emailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
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
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION }
    );

    return res.status(200).json({
      success: true,
      message: "Google authentication successful",
      token,
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
