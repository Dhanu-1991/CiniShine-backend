// routes/videoRoutes/videoRouter.js
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
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

router.get("/video/:id", universalTokenVerifier, getVideo);
router.get('/video/:id/master.m3u8', universalTokenVerifier, getHLSMasterPlaylist);
router.get('/video/:id/variants/:variantFile', universalTokenVerifier, getHLSVariantPlaylist);
router.get('/video/:id/segments/:segmentFile', universalTokenVerifier, getHLSSegment);
router.get("/video/:id/status", universalTokenVerifier, getVideoStatus);
router.post("/video/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/video/upload/init", universalTokenVerifier, uploadInit);
router.get("/video/user/my-content", universalTokenVerifier, getMyContent);

export default router;