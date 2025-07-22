import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
dotenv.config();

import authRouter from "./routes/authRoutes/authRouter.js";
import errorHandlingMiddleware from "./middlewares/errorHandlingMiddleware.js";
import router from "./routes/paymentRoutes/cashfree.js";

const app = express();

const corsOptions = {
  origin: "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
  credentials: true,
};

app.use(cors(corsOptions));


// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Routes
app.use("/api/v1/payments", router);
app.use("/api/v1/auth/authRoutes", authRouter);

// Global error handler
app.use(errorHandlingMiddleware);

// Connect to MongoDB and Start Server
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`✅ Server running on port ${process.env.PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  });
