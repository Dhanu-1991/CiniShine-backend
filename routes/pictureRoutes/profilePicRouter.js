import express from "express";
import multer from "multer";
import {
    updateProfilePicture,
    removeProfilePicture,
    getProfilePicture,
} from "../../controllers/picture-controllers/profilePicController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const profilePicRouter = express.Router();

// Multer memory storage
const storage = multer.memoryStorage();

// Image-only filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Only image files are allowed"), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/**
 * @route   PUT /api/v1/user/profile-picture/update-picture
 * @desc    Update profile picture
 * @access  Private
 */
profilePicRouter.put(
    "/update-picture",
    universalTokenVerifier,
    upload.single("profilePicture"),
    updateProfilePicture
);

/**
 * @route   DELETE /api/v1/user/profile-picture/delete-picture
 * @desc    Remove profile picture
 * @access  Private
 */
profilePicRouter.delete(
    "/delete-picture",
    universalTokenVerifier,
    removeProfilePicture
);

/**
 * @route   GET /api/v1/user/profile-picture/get-picture/:userId
 * @desc    Get profile picture
 * @access  Public
 */
profilePicRouter.get(
    "/get-picture/:userId",
    getProfilePicture
);

export default profilePicRouter;
