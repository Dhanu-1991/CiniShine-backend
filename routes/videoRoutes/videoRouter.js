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
  recordView,
  getGeneralContent,
  getUserPreferences,
  updateUserPreferences
} from "../../controllers/video-controllers/videoController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

// CRITICAL: Route order matters! Most specific first, general last

// Upload routes (very specific)
router.post("/video/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/video/upload/init", universalTokenVerifier, uploadInit);

// User content route (specific path)
router.get("/video/user/my-content", universalTokenVerifier, getMyContent);

router.get("/user/preferences", universalTokenVerifier, getUserPreferences);

// NEW: update user preferences
router.put("/user/preferences", universalTokenVerifier, updateUserPreferences);

router.get("/video/general/content", getGeneralContent);

// HLS streaming routes (MUST come before general :id routes)
// Master playlist route
router.get('/video/:id/master.m3u8', universalTokenVerifier, getHLSMasterPlaylist);

// Variant playlist route (for quality-specific playlists like 144p, 360p, etc.)
router.get('/video/:id/variants/:variantFile', universalTokenVerifier, getHLSVariantPlaylist);

// Segment routes (for .ts, .m4s, .mp4, .aac files)
router.get('/video/:id/segments/:segmentFile', universalTokenVerifier, getHLSSegment);

// Legacy segment route (if you have old URLs with userId in path)
// router.get('/video/:userId/:videoId/segments/:segmentFile', universalTokenVerifier, getHLSSegment);

// View tracking route (POST not GET)
router.post("/video/:id/view", universalTokenVerifier, recordView);

// Status route (specific with /status suffix)
router.get("/video/:id/status", universalTokenVerifier, getVideoStatus);

// General video route (MUST BE LAST - catches all /video/:id)
router.get("/video/:id", universalTokenVerifier, getVideo);

export default router;