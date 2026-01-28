import express from "express";
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
  getRecommendations
} from "../../controllers/video-controllers/videoController.js";
import { likeVideo, dislikeVideo, subscribeToUser, updateWatchTime } from "../../controllers/video-controllers/interactions.js";
import { searchVideos } from "../../controllers/video-controllers/search.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";
import commentRouter from "../commentRoutes/commentRouter.js";

const router = express.Router();

// CRITICAL: Route order matters! Most specific first, general last

// Upload routes (very specific)
router.post("/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/upload/init", universalTokenVerifier, uploadInit);

// User content route (specific path)
router.get("/user/my-content", universalTokenVerifier, getMyContent);
router.get("/user/content", universalTokenVerifier, getContent);

router.get("/user/preferences", universalTokenVerifier, getUserPreferences);

// NEW: update user preferences
router.put("/user/preferences", universalTokenVerifier, updateUserPreferences);

router.get("/general/content", getGeneralContent);

// Recommendations route
router.get("/:videoId/recommendations", universalTokenVerifier, getRecommendations);

// Search route
router.get("/search", universalTokenVerifier, searchVideos);

// HLS streaming routes (MUST come before general :id routes)
// Master playlist route
router.get('/:id/master.m3u8', universalTokenVerifier, getHLSMasterPlaylist);

// Variant playlist route (for quality-specific playlists like 144p, 360p, etc.)
router.get('/:id/variants/:variantFile', universalTokenVerifier, getHLSVariantPlaylist);

// Segment routes (for .ts, .m4s, .mp4, .aac files)
router.get('/:id/segments/:segmentFile', universalTokenVerifier, getHLSSegment);

// Legacy segment route (if you have old URLs with userId in path)
// router.get('/video/:userId/:videoId/segments/:segmentFile', universalTokenVerifier, getHLSSegment);



// Like/Dislike routes
router.post("/:id/like", universalTokenVerifier, likeVideo);
router.post("/:id/dislike", universalTokenVerifier, dislikeVideo);

// Comments routes
router.use("/:videoId/comments", commentRouter);
// router.use("/comments", commentRouter);

// Subscribe route
router.post("/user/:userId/subscribe", universalTokenVerifier, subscribeToUser);

// Watch time tracking
router.post("/:id/watch-time", universalTokenVerifier, updateWatchTime);

// Status route (specific with /status suffix)
router.get("/:id/status", universalTokenVerifier, getVideoStatus);

// General video route (MUST BE LAST - catches all /video/:id)
router.get("/:id", universalTokenVerifier, getVideo);

export default router;