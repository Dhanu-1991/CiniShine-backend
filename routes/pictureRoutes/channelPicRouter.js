import express from "express";
import multer from "multer";
import {
    updateChannelPicture,
    removeChannelPicture,
    getChannelPicture,
} from "../../controllers/picture-controllers/channelPicController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const channelPicRouter = express.Router();

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
 * @route   PUT /api/v1/user/channel-picture
 * @desc    Update channel picture
 * @access  Private
 */
channelPicRouter.put(
    "/update-picture",
    universalTokenVerifier,
    upload.single("channelPicture"),
    updateChannelPicture
);

/**
 * @route   DELETE /api/v1/user/channel-picture
 * @desc    Remove channel picture
 * @access  Private
 */
channelPicRouter.delete(
    "/delete-picture",
    universalTokenVerifier,
    removeChannelPicture
);

/**
 * @route   GET /api/v1/user/channel-picture/:userId
 * @desc    Get channel picture
 * @access  Public
 */
channelPicRouter.get(
    "/get-picture/:userId",
    getChannelPicture
);

export default channelPicRouter;
