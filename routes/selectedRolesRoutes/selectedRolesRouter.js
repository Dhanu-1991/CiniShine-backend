import express from "express";
import multer from "multer";
import { storage } from "../../../config/cloudinary.js";
import { selectedRoles } from "../../controllers/auth-users-controllers/selected-roles.js";
import { getRoles } from "../../controllers/auth-users-controllers/getRoles.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

// Multer with cloudinary storage
const upload = multer({ storage });

router.post(
  "/submit",
  upload.fields([
    { name: "profilePicture", maxCount: 1 },
    { name: "achievementsPDF", maxCount: 1 },
  ]),
  selectedRoles
);
router.get("/roles", universalTokenVerifier, getRoles);

export default router;
