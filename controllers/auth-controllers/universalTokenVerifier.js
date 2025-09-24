// UniversalTokenVerifier.js
import jwt from "jsonwebtoken";

export const universalTokenVerifier = async (req,res,next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      console.log("❌ No token provided");
      return { status: 401, message: "No token provided" };
    }
    console.log("🔑 Token found:", token);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.userId };
    console.log("✅ Token verified successfully:", decoded);
    next();
  } catch (err) {
    console.error("❌ Token verification failed:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
