import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
dotenv.config();

export const userData = async (req, res) => {
  console.log("Fetching user data...");
  try {
    const userId = req.user?.id;
    const user = await User.findById(userId).select('-password');
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
