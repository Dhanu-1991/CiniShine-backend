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
  origin: "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
  credentials: true,
};

// ✅ CORS setup
app.use(cors(corsOptions));

// ✅ Webhook route with raw body BEFORE any json middleware
app.post(
  "/api/v1/payments/payment-webhook",
  express.raw({ type: "application/json" }),
  handleCashfreeWebhook
);

// ✅ JSON/body middleware AFTER webhook
app.use(express.json());
app.use(cookieParser());

// ✅ Other routes
app.use("/api/v1/payments", router);
app.use("/api/v1/auth/authRoutes", authRouter);

// ✅ Global error handler
app.use(errorHandlingMiddleware);

// ✅ Connect and run server
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
