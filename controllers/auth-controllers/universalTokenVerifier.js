// UniversalTokenVerifier.js
import jwt from "jsonwebtoken";

export const universalTokenVerifier = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      console.log("❌ No token provided");
      return res.status(401).json({ message: "No token provided" });
    }
    console.log("🔑 Token found:", token.substring(0, 20) + "...");

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.userId };
    console.log("✅ Token verified successfully for user:", decoded.userId);
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      console.log("⏰ Token has expired");
      return res.status(401).json({ message: "Token expired" });
    }

    console.log("❌ Token verification failed:", error.message);
    return res.status(401).json({ message: "Invalid token" });
  }
};
