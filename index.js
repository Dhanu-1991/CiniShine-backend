// index.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
dotenv.config();

import authRouter from "./routes/authRoutes/authRouter.js";
import errorHandlingMiddleware from "./middlewares/errorHandlingMiddleware.js";
import router from "./routes/paymentRoutes/cashfree.js";
import { handleCashfreeWebhook } from "./controllers/payment-gateway-controllers/payment-webhook.js";
import contactRouter from "./routes/contactRoutes/contactRouter.js";
import selectedRolesRouter from "./routes/selectedRolesRoutes/selectedRolesRouter.js";
import videoRouter from "./routes/contentRoutes/videoRouter.js"; // Moved to contentRoutes
import contentRouter from "./routes/contentRoutes/contentRouter.js"; // Shorts, Audio, Posts
import channelRouter from "./routes/channelRoutes/channelRouter.js"; // Channel pages
import historyRouter from "./routes/historyRoutes/historyRouter.js"; // Watch history
import profileRouter from "./routes/profileRoutes/profileRouter.js"; // Creator profile
import channelPicRouter from "./routes/pictureRoutes/channelPicRouter.js";
import profilePicRouter from "./routes/pictureRoutes/profilePicRouter.js";
import { issueCloudFrontCookies } from "./config/cloudfront.js";
import { universalTokenVerifier } from "./controllers/auth-controllers/universalTokenVerifier.js";

const app = express();

app.set('trust proxy', 1);

const corsOptions = {
  origin: [
    "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
    "https://frontend-six-black-29.vercel.app"
  ],
  credentials: true,
};
app.use(cors(corsOptions));

// Raw-body capture (for webhook signature)
const getRawBody = (req, res, next) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
};

// Webhook route
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody,
  handleCashfreeWebhook
);

// All other routes get normal JSON/body parsing
app.use(express.json());
app.use(cookieParser());

app.use("/api/v1/contact", contactRouter);
app.use("/api/v1/payments", router);//
app.use("/api/v1/auth/authRoutes", authRouter);
app.use("/api/data/selected-roles", selectedRolesRouter);
app.use("/api/v1/user/channel-picture", channelPicRouter);
app.use("/api/v1/user/profile-picture", profilePicRouter);
app.use("/api/v2/video", videoRouter);
app.use("/api/v2/content", contentRouter); // Shorts, Audio, Posts
app.use("/api/v2/channel", channelRouter); // Channel pages
app.use("/api/v2/history", historyRouter); // Watch history
app.use("/api/v2/profile", profileRouter); // Creator profile

// CloudFront signed cookies endpoint (protected — user must be logged in)
app.get("/api/v2/auth/cloudfront-cookies", universalTokenVerifier, issueCloudFrontCookies);

app.use(errorHandlingMiddleware);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");
    app.listen(process.env.PORT, () =>
      console.log(`✅ Server running on port ${process.env.PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err);
    process.exit(1);
  });