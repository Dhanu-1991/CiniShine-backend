// tokenverifier.js
import jwt from "jsonwebtoken";

export const tokenVerifier = async (req) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return { status: 401, message: "No token provided" };
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return { status: 200, message: "Token valid", userId: decoded.userId };
  } catch (err) {
    return { status: 401, message: "Invalid or expired token" };
  }
};
