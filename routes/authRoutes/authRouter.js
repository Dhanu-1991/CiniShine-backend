import express from 'express';
import { Signup } from '../../controllers/auth-controllers/signup.js';
import checkUser from '../../controllers/auth-controllers/checkUser/auth.checkuser.js';
// import { sendOtp } from '../../controllers/auth-controllers/sendotp-forgotpass.js';
import { sendOtp } from '../../controllers/auth-controllers/sendotp-signup.js'
import { verifyOtp } from '../../controllers/auth-controllers/verifyotp.js';
import { signIn } from '../../controllers/auth-controllers/signin.js';
import changePassword from '../../controllers/auth-controllers/changepassword.js';
import { verifyToken } from '../../controllers/auth-controllers/checkUser/verifytoken.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import { userData } from '../../controllers/auth-controllers/userdata.js';
import { updateChannel, checkHandleAvailability, generateHandleSuggestion } from '../../controllers/auth-controllers/updateChannel.js';
const authRouter = express.Router();
//
authRouter.post("/sendOtp/signup", sendOtp);
authRouter.post("/checkUser", checkUser);
authRouter.post("/verifyOtp", verifyOtp);
authRouter.post("/signup", Signup);
authRouter.post("/signin", signIn);
authRouter.post("/sendOtp/forgotPass", sendOtp);
authRouter.post("/signin/changePassword", changePassword);
// authRouter.get("/verify-token", verifyToken);
authRouter.get("/user-data", universalTokenVerifier, userData);
authRouter.put("/update-channel", universalTokenVerifier, updateChannel);
authRouter.get("/check-handle", universalTokenVerifier, checkHandleAvailability);
authRouter.get("/generate-handle", universalTokenVerifier, generateHandleSuggestion);
export default authRouter;