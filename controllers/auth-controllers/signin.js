import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
dotenv.config();

const signIn = async (req, res, next) => {
  try {
    const { contact, password } = req.body;

    // 1. Check if user exists
    const user = await User.findOne({ contact });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // 3. Generate token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRATION,
    });
    console.log("signin successful");

    return res.status(200).json({
      success: true,
      message: "Signin successful",
      token,
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
