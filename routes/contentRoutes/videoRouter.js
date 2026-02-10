/**
 * Video Router - /api/v2/video
 * All video routes (addresses UNCHANGED from original)
 * Moved from routes/videoRoutes/videoRouter.js
 */

import express from "express";
import multer from "multer";
import {
    getVideo,
    getVideoStatus,
    uploadComplete,
    uploadInit,
    getMyContent,
    getHLSMasterPlaylist,
    getHLSVariantPlaylist,
    getHLSSegment,
    getGeneralContent,
    getUserPreferences,
    updateUserPreferences,
    getContent,
    getRecommendations,
    uploadVideoThumbnail,
    getSpecificContent,
} from "../../controllers/content-controllers/videoController.js";
import { getMixedFeed, getRecommendationsWithShorts } from "../../controllers/content-controllers/feedController.js";
import { likeVideo, dislikeVideo, subscribeToUser, updateWatchTime } from "../../controllers/content-controllers/interactions.js";
import { searchVideos, getSearchSuggestions, clearSearchHistory } from "../../controllers/content-controllers/search.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";
import commentRouter from "../commentRoutes/commentRouter.js";

// Configure multer for thumbnail uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'), false);
    }
});

const router = express.Router();

// CRITICAL: Route order matters! Most specific first, general last

// Upload routes
router.post("/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/upload/init", universalTokenVerifier, uploadInit);

// User content routes
router.get("/user/my-content", universalTokenVerifier, getMyContent);
router.get("/user/content", universalTokenVerifier, getContent);
router.get("/user/content/:creatorId", universalTokenVerifier, getSpecificContent);
router.get("/user/preferences", universalTokenVerifier, getUserPreferences);
router.put("/user/preferences", universalTokenVerifier, updateUserPreferences);

router.get("/general/content", getGeneralContent);

// Mixed feed route
router.get("/feed/mixed", universalTokenVerifier, getMixedFeed);

// Recommendations
router.get("/:videoId/recommendations", universalTokenVerifier, getRecommendations);
router.get("/:videoId/recommendations-with-shorts", universalTokenVerifier, getRecommendationsWithShorts);

// Search
router.get("/search/suggestions", universalTokenVerifier, getSearchSuggestions);
router.delete("/search/history", universalTokenVerifier, clearSearchHistory);
router.get("/search", universalTokenVerifier, searchVideos);

// HLS streaming
router.get('/:id/master.m3u8', universalTokenVerifier, getHLSMasterPlaylist);
router.get('/:id/variants/:variantFile', universalTokenVerifier, getHLSVariantPlaylist);
router.get('/:id/segments/:segmentFile', universalTokenVerifier, getHLSSegment);

// Like/Dislike
router.post("/:id/like", universalTokenVerifier, likeVideo);
router.post("/:id/dislike", universalTokenVerifier, dislikeVideo);

// Comments
router.use("/:videoId/comments", commentRouter);

// Subscribe
router.post("/user/:userId/subscribe", universalTokenVerifier, subscribeToUser);

// Watch time
router.post("/:id/watch-time", universalTokenVerifier, updateWatchTime);

// Thumbnail upload
router.post("/:id/thumbnail", universalTokenVerifier, upload.single('thumbnail'), uploadVideoThumbnail);

// Status
router.get("/:id/status", universalTokenVerifier, getVideoStatus);

// General video route (MUST BE LAST)
router.get("/:id", universalTokenVerifier, getVideo);

export default router;
