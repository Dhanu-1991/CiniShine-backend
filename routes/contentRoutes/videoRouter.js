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
import { searchVideos, getSearchSuggestions, clearSearchHistory, unifiedSearch } from "../../controllers/content-controllers/search.js";
import { multipartInit, multipartComplete, multipartAbort } from "../../controllers/content-controllers/multipartUploadController.js";
import { universalTokenVerifier, optionalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";
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

// Multipart upload routes (fast parallel chunked uploads)
router.post("/upload/multipart/init", universalTokenVerifier, multipartInit);
router.post("/upload/multipart/complete", universalTokenVerifier, multipartComplete);
router.post("/upload/multipart/abort", universalTokenVerifier, multipartAbort);

// Legacy upload routes (single PUT - kept for backward compat)
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
router.get("/feed/mixed", optionalTokenVerifier, getMixedFeed);

// Recommendations
router.get("/:videoId/recommendations", optionalTokenVerifier, getRecommendations);
router.get("/:videoId/recommendations-with-shorts", optionalTokenVerifier, getRecommendationsWithShorts);

// Search
router.get("/search/suggestions", optionalTokenVerifier, getSearchSuggestions);
router.get("/search/unified", optionalTokenVerifier, unifiedSearch);
router.delete("/search/history", universalTokenVerifier, clearSearchHistory);
router.get("/search", optionalTokenVerifier, searchVideos);

// HLS streaming (public - any viewer can stream)
router.get('/:id/master.m3u8', optionalTokenVerifier, getHLSMasterPlaylist);
router.get('/:id/variants/:variantFile', optionalTokenVerifier, getHLSVariantPlaylist);
router.get('/:id/segments/:segmentFile', optionalTokenVerifier, getHLSSegment);

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
router.get("/:id/status", optionalTokenVerifier, getVideoStatus);

// General video route (MUST BE LAST)
router.get("/:id", optionalTokenVerifier, getVideo);

export default router;
