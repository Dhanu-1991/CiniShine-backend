import express from 'express';
import { Signup } from '../../controllers/auth-controllers/signup.js';
import checkUser from '../../controllers/auth-controllers/checkUser/auth.checkuser.js';
import { sendOtp_forgotPass } from '../../controllers/auth-controllers/sendotp-forgotpass.js';
import { sendOtp_signup } from '../../controllers/auth-controllers/sendotp-signup.js'
import { verifyOtp } from '../../controllers/auth-controllers/verifyotp.js';
import {signIn} from '../../controllers/auth-controllers/signin.js';
import changePassword from '../../controllers/auth-controllers/changepassword.js';
import { verifyToken } from '../../controllers/auth-controllers/checkUser/verifytoken.js';
import { userData } from '../../controllers/auth-controllers/userdata.js';
const authRouter = express.Router();
//
authRouter.post("/sendOtp/signup", sendOtp_signup);
authRouter.post("/checkUser", checkUser);
authRouter.post("/verifyOtp",verifyOtp)
authRouter.post("/signup", Signup);
authRouter.post("/signin",signIn);
authRouter.post("/sendOtp/forgotPass", sendOtp_forgotPass);
authRouter.post("/signin/changePassword", changePassword);
authRouter.get("/verify-token", verifyToken);
authRouter.get("/user-data", userData);
export default authRouter;