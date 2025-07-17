import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
dotenv.config();

export const userData = async (req, res) => {
  console.log("Fetching user data...");
  try {
    console.log("Verifying token...");
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      console.log("Token found in headers");
      token = req.headers.authorization.split(" ")[1];
    }
    console.log("Token:", token);

    // ✅ Return immediately if no token
    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Return if token is invalid
    if (!decoded) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    console.log("Token is valid. User ID:", decoded.userId);
    const user = await User.findById(decoded.userId).select('-password'); 
    console.log("User found:", user);
    return res.status(200).json({
      message: "User is authorized",
      user
    });

  } catch (error) {
    if (error.name === "TokenExpiredError") {
      console.log("Token has expired.");
      return res.status(401).json({ message: "Token expired" });
    }

    // ✅ Return on unexpected error
    return res.status(500).json({ message: "Internal server error" });
  }
};
