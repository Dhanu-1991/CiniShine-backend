// UniversalTokenVerifier.js
import jwt from "jsonwebtoken";

export const universalTokenVerifier = async (req, res, next) => {
  try {
    let token = null;

    // 1. Try Authorization header first (for API calls from axios/fetch)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
      console.log('🔑 Token from Authorization header');
    }

    // 2. If no header token, try cookies (for video element requests)
    if (!token && req.cookies) {
      token = req.cookies.accessToken || req.cookies.token || req.cookies.auth_token;
      if (token) {
        console.log('🍪 Token from cookies');
      }
    }

    // 3. Fallback: check query params (some video players use this)
    if (!token && req.query.token) {
      token = req.query.token;
      console.log('🔗 Token from query params');
    }

    if (!token) {
      console.log('❌ No token found in:', {
        path: req.path,
        method: req.method,
        hasAuthHeader: !!req.headers.authorization,
        cookies: req.cookies ? Object.keys(req.cookies) : [],
        hasQueryToken: !!req.query.token
      });
      return res.status(401).json({
        message: "No token provided",
        error: "Authentication required"
      });
    }

    console.log("🔑 Token found, verifying...");

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user info to request (support multiple token formats)
    req.user = decoded.userId || decoded.id || decoded._id;
    req.userEmail = decoded.email;
    req.tokenData = decoded;

    console.log("✅ Token verified successfully for user:", req.user);
    next();

  } catch (error) {
    console.error("❌ Token verification failed:", {
      name: error.name,
      message: error.message,
      path: req.path
    });

    if (error.name === "TokenExpiredError") {
      console.log("⏰ Token has expired");
      return res.status(401).json({
        message: "Token expired",
        error: "Your session has expired. Please login again."
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        message: "Invalid token",
        error: "Authentication token is invalid"
      });
    }

    // Unexpected error
    return res.status(500).json({
      message: "Internal server error",
      error: "Failed to verify authentication"
    });
  }
};