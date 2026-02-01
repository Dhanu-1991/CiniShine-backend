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
  uploadVideoThumbnail
} from "../../controllers/video-controllers/videoController.js";
import { getMixedFeed, getRecommendationsWithShorts } from "../../controllers/video-controllers/feedController.js";
import { likeVideo, dislikeVideo, subscribeToUser, updateWatchTime } from "../../controllers/video-controllers/interactions.js";
import { searchVideos, getSearchSuggestions, clearSearchHistory } from "../../controllers/video-controllers/search.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";
import commentRouter from "../commentRoutes/commentRouter.js";

// Configure multer for thumbnail uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

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

// Mixed feed route (videos, shorts, audio, posts with recommendation algorithm)
router.get("/feed/mixed", universalTokenVerifier, getMixedFeed);

// Recommendations route (videos only - legacy)
router.get("/:videoId/recommendations", universalTokenVerifier, getRecommendations);

// Recommendations with shorts (for WatchPage sidebar)
router.get("/:videoId/recommendations-with-shorts", universalTokenVerifier, getRecommendationsWithShorts);

// Search routes - suggestions returns text queries, search returns videos
router.get("/search/suggestions", universalTokenVerifier, getSearchSuggestions);
router.delete("/search/history", universalTokenVerifier, clearSearchHistory);
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

// Custom thumbnail upload for videos
router.post("/:id/thumbnail", universalTokenVerifier, upload.single('thumbnail'), uploadVideoThumbnail);

// Status route (specific with /status suffix)
router.get("/:id/status", universalTokenVerifier, getVideoStatus);

// General video route (MUST BE LAST - catches all /video/:id)
router.get("/:id", universalTokenVerifier, getVideo);

export default router;