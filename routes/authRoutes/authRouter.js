import express from 'express';
import { Signup } from '../../controllers/auth-controllers/signup.js';
import checkUser from '../../controllers/auth-controllers/checkUser/auth.checkuser.js';
import { sendOtp } from '../../controllers/auth-controllers/sendotp-signup.js'
import { verifyOtp } from '../../controllers/auth-controllers/verifyotp.js';
import { signIn } from '../../controllers/auth-controllers/signin.js';
import { googleAuth } from '../../controllers/auth-controllers/googleAuth.js';
import changePassword from '../../controllers/auth-controllers/changepassword.js';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import { userData } from '../../controllers/auth-controllers/userdata.js';
import { updateChannel, checkHandleAvailability, generateHandleSuggestion } from '../../controllers/auth-controllers/updateChannel.js';
import { refreshToken } from '../../controllers/auth-controllers/refreshToken.js';
import { logout } from '../../controllers/auth-controllers/logoutController.js';

const authRouter = express.Router();

// Public auth routes
authRouter.post("/sendOtp/signup", sendOtp);
authRouter.post("/checkUser", checkUser);
authRouter.post("/verifyOtp", verifyOtp);
authRouter.post("/signup", Signup);
authRouter.post("/signin", signIn);
authRouter.post("/google-auth", googleAuth);
authRouter.post("/sendOtp/forgotPass", sendOtp);
authRouter.post("/signin/changePassword", changePassword);

// Token refresh — uses refresh_token cookie (no auth middleware needed)
authRouter.post("/refresh", refreshToken);

// Logout — optionalTokenVerifier so it works even if access token expired
authRouter.post("/logout", optionalTokenVerifier, logout);

// Auth check endpoint — returns user data if authenticated, 401 if not
authRouter.get("/me", universalTokenVerifier, userData);

// Protected routes
authRouter.get("/user-data", universalTokenVerifier, userData);
authRouter.put("/update-channel", universalTokenVerifier, updateChannel);
authRouter.get("/check-handle", universalTokenVerifier, checkHandleAvailability);
authRouter.get("/generate-handle", universalTokenVerifier, generateHandleSuggestion);

export default authRouter;