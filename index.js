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

const app = express();

const corsOptions = {
  // Remember to update this to your new frontend URL
  origin: "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app", 
  credentials: true,
};

app.use(cors(corsOptions));

// This custom middleware captures the true raw request body.
// It's the most reliable way to ensure the body is not altered.
const getRawBody = (req, res, next) => {
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
};

// The webhook route uses ONLY our custom raw body middleware.
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody,
  handleCashfreeWebhook
);

// Standard JSON parser for all your other API routes.
// This is placed AFTER the special webhook route.
app.use(express.json());
app.use(cookieParser());

// Your other application routes
app.use("/api/v1/payments", router);
app.use("/api/v1/auth/authRoutes", authRouter);

// Global error handler
app.use(errorHandlingMiddleware);

// Database connection and server start
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    app.listen(process.env.PORT, () =>
      console.log(`✅ Server running on port ${process.env.PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err);
    process.exit(1);
  });