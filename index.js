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
import videoRouter from "./routes/videoRoutes/videoRouter.js";

const app = express();

app.set('trust proxy', 1);

// Allowed origins list
const allowedOrigins = [
  "https://cini-shine-fullstack-hru4-git-main-dhanu-1991s-projects.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "https://frontend-six-black-29.vercel.app"
];

// CORS configuration with dynamic origin checking
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ Blocked by CORS: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // CRITICAL: Allow cookies and authentication headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: [
    'Content-Range',
    'Content-Length',
    'ETag',
    'X-Content-Type-Options'
  ],
  maxAge: 86400, // Cache preflight requests for 24 hours
};

app.use(cors(corsOptions));

// Handle preflight requests explicitly for all routes
app.options('*', cors(corsOptions));

// Raw-body capture (for webhook signature) - BEFORE body parsers
const getRawBody = (req, res, next) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
};

// Webhook route (needs raw body)
app.post(
  "/api/v1/payments/payment-webhook",
  getRawBody,
  handleCashfreeWebhook
);

// All other routes get normal JSON/body parsing
app.use(express.json());
app.use(cookieParser());

// Routes
app.use("/api/v1/contact", contactRouter);
app.use("/api/v1/payments", router);
app.use("/api/v1/auth/authRoutes", authRouter);
app.use("/api/data/selected-roles", selectedRolesRouter);
app.use("/api/v2", videoRouter);

// Error handling middleware (MUST be last)
app.use(errorHandlingMiddleware);

// Health check endpoint (optional but recommended)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Database connection and server start
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");
    app.listen(process.env.PORT, () => {
      console.log(`✅ Server running on port ${process.env.PORT}`);
      console.log(`🌐 Allowed origins:`, allowedOrigins);
    });
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err);
    process.exit(1);
  });