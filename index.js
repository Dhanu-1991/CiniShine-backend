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

app.use(cors(corsOptions));

// ✅ Step 1: Define a middleware to get the TRUE raw body
const getRawBody = (req, res, next) => {
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });
  req.on('end', () => {
    // Attach the raw body buffer to the request object
    req.rawBody = Buffer.concat(chunks);
    next();
  });
};

// ✅ Step 2: Use the custom middleware ONLY for the webhook route
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody, // Use our custom raw body capturer
  handleCashfreeWebhook
);

// ✅ Step 3: All other middlewares come AFTER the webhook route
app.use(express.json()); // For all other routes
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