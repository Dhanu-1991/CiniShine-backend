// index.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
dotenv.config();

import authRouter from "./routes/authRoutes/authRouter.js";
import errorHandlingMiddleware from "./middlewares/errorHandlingMiddleware.js";
import router from "./routes/paymentRoutes/index.js";
import { handleCashfreeWebhook } from "./controllers/payment-gateway-controllers/payment-webhook.js";
import { handleRazorpayWebhook } from "./controllers/payment-gateway-controllers/razorpay-webhook.js";
import contactRouter from "./routes/contactRoutes/contactRouter.js";
import selectedRolesRouter from "./routes/selectedRolesRoutes/selectedRolesRouter.js";
import videoRouter from "./routes/contentRoutes/videoRouter.js"; // Moved to contentRoutes
import contentRouter from "./routes/contentRoutes/contentRouter.js"; // Shorts, Audio, Posts
import channelRouter from "./routes/channelRoutes/channelRouter.js"; // Channel pages
import historyRouter from "./routes/historyRoutes/historyRouter.js"; // Watch history
import profileRouter from "./routes/profileRoutes/profileRouter.js"; // Creator profile
import channelPicRouter from "./routes/pictureRoutes/channelPicRouter.js";
import profilePicRouter from "./routes/pictureRoutes/profilePicRouter.js";
import bookmarkRouter from "./routes/bookmarkRoutes/bookmarkRouter.js";
import chatRouter from "./routes/chatRoutes/chatRouter.js";
import notificationRouter from "./routes/notificationRoutes/notificationRouter.js";
import communityRouter from "./routes/communityRoutes/communityRouter.js";
import { issueCloudFrontCookies } from "./config/cloudfront.js";
import { universalTokenVerifier } from "./controllers/auth-controllers/universalTokenVerifier.js";
import adminRouter from "./routes/adminRoutes/adminRouter.js";
import analyticsRouter from "./routes/analyticsRoutes/analyticsRouter.js";
import walletRouter from "./routes/walletRoutes/walletRouter.js";
import referralRouter from "./routes/referralRoutes.js";
import { startViewCountFlusher, stopViewCountFlusher } from "./utils/viewCountQueue.js";

// ── Global crash handlers — prevent silent 521 ─────────────────────────
process.on("uncaughtException", (err) => {
  console.error("💥 UNCAUGHT EXCEPTION:", err.message, err.stack);
  // Give time for logs to flush, then exit so Render can restart
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 UNHANDLED REJECTION:", reason);
});
// ────────────────────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1);

const corsOptions = {
  origin: [
    "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
    "app://localhost",
    "https://frontend-six-black-29.vercel.app",
    "https://watchinit.com",
    "https://admin.watchinit.com",
    "https://cineshine-private.vercel.app"

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

// Webhook routes
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody,
  handleCashfreeWebhook
);

app.post(
  "/api/v1/payments/razorpay-webhook",
  express.json(), // Razorpay webhook handler uses stringified req.body
  handleRazorpayWebhook
);

// All other routes get normal JSON/body parsing
app.use(express.json());
app.use(cookieParser());

// ── Global spam protection — rate limit all API routes ────────────────────
const globalRateLimitStore = new Map();
const GLOBAL_RATE_LIMIT = 100; // max requests per window
const GLOBAL_RATE_WINDOW = 60000; // 1 minute window

app.use('/api', (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = globalRateLimitStore.get(key);

    if (!record || now > record.resetAt) {
        globalRateLimitStore.set(key, { count: 1, resetAt: now + GLOBAL_RATE_WINDOW });
        return next();
    }

    record.count++;
    if (record.count > GLOBAL_RATE_LIMIT) {
        return res.status(429).json({
            success: false,
            message: 'Too many requests. Please slow down and try again later.'
        });
    }
    next();
});

// Cleanup stale global rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of globalRateLimitStore) {
        if (now > record.resetAt) globalRateLimitStore.delete(key);
    }
}, 5 * 60 * 1000);

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
app.use("/api/v2/bookmarks", bookmarkRouter); // Bookmarks
app.use("/api/v2/chats", chatRouter); // Chat / Messaging
app.use("/api/v2/notifications", notificationRouter); // Notifications
app.use("/api/v2/communities", communityRouter); // Communities

// Admin panel
app.use("/api/admin", adminRouter);

// Analytics tracking (page usage, content watchtime, sessions)
app.use("/api/v2/analytics", analyticsRouter);
app.use("/api/v2/referrals", referralRouter);
app.use("/api/v2", walletRouter); // Wallet system

// CloudFront signed cookies endpoint (protected — user must be logged in)
app.get("/api/v2/auth/cloudfront-cookies", universalTokenVerifier, issueCloudFrontCookies);

// Health check endpoint for Render
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(errorHandlingMiddleware);

const port = process.env.PORT || 5000;
app.listen(port, () =>
  console.log(`✅ Express Server listening on port ${port}`)
);

const connectWithRetry = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
    });
    console.log("✅ MongoDB connected successfully");
    startViewCountFlusher();

  } catch (err) {
    console.error("❌ DB connection attempt failed, retrying in 3s...", err.message);
    setTimeout(connectWithRetry, 3000);
  }
};
connectWithRetry();

// Graceful shutdown: flush pending view counts
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, flushing view counts...');
  await stopViewCountFlusher();
  process.exit(0);
});