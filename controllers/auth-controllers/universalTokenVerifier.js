// UniversalTokenVerifier.js
import jwt from "jsonwebtoken";

/**
 * Extract token from request — checks cookie first, then Authorization header.
 * This supports both cookie-based auth (new) and header-based auth (backward compat).
 */
const extractToken = (req) => {
  // 1. Check httpOnly cookie first (primary)
  if (req.cookies?.access_token) {
    return req.cookies.access_token;
  }

  // 2. Fall back to Authorization header (backward compat / mobile / admin)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }

  return null;
};

export const universalTokenVerifier = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    return res.status(401).json({ message: "Invalid token" });
  }
};

// Optional token verifier - doesn't fail if no token, just sets req.user if valid
export const optionalTokenVerifier = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      // No token is fine, just continue without user
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (error) {
    // Token invalid/expired, but we still continue without user
    next();
  }
};
