import express from "express";
import {
  getVideo,
  getVideoStatus,
  uploadComplete,
  uploadInit,
  getMyContent,
  getHLSMasterPlaylist,
  getHLSVariantPlaylist,
  getHLSSegment
} from "../../controllers/video-controllers/videoController.js";
import { updateViewCount } from "../../controllers/video-controllers/videoParameters.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

// CRITICAL: Route order matters! Most specific first, general last

// Upload routes (very specific)
router.post("/video/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/video/upload/init", universalTokenVerifier, uploadInit);

// User content route (specific path)
router.get("/video/user/my-content", universalTokenVerifier, getMyContent);

// HLS streaming routes (specific with multiple path segments)
router.get('/video/:id/master.m3u8', universalTokenVerifier, getHLSMasterPlaylist);
router.get('/video/:id/variants/:variantFile', universalTokenVerifier, getHLSVariantPlaylist);
router.get('/video/:userId/:videoId/segments/:segmentFile', universalTokenVerifier, getHLSSegment);
router.get('/video/:id/segments/:segmentFile', universalTokenVerifier, getHLSSegment);

router.get("/video/:id/view", universalTokenVerifier, updateViewCount);

// Status route (specific with /status suffix)
router.get("/video/:id/status", universalTokenVerifier, getsVideoStatus);

// General video route (MUST BE LAST - catches all /video/:id)
router.get("/video/:id", universalTokenVerifier, getVideo);

export default router;