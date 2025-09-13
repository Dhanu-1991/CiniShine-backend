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

const app = express();

const corsOptions = {
  origin: [
    "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
    "http://localhost:5173", // Add your local development URL here
    "http://127.0.0.1:5173",
    "https://frontend-six-black-29.vercel.app" // Add 127.0.0.1 as a common localhost address
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

// 1️⃣ Webhook route uses only `getRawBody`
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody,
  handleCashfreeWebhook
);

// 2️⃣ All other routes get normal JSON/body parsing
app.use(express.json());
app.use(cookieParser());

app.use("/api/v1/contact", contactRouter);
app.use("/api/v1/payments", router);
app.use("/api/v1/auth/authRoutes", authRouter);
app.use("/api/data/selected-roles", selectedRolesRouter);
app.use(errorHandlingMiddleware);

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
