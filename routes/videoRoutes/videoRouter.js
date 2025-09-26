// routes/videoRoutes/videoRouter.js
import express from "express";
import { 
  getVideo, 
  getVideoStatus, 
  uploadComplete, 
  uploadInit 
} from "../../controllers/video-controllers/videoController.js";
import { universalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

router.get("/video/:id", universalTokenVerifier, getVideo);
router.get("/video/:id/status", universalTokenVerifier, getVideoStatus);
router.post("/video/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/video/upload/init", universalTokenVerifier, uploadInit);

export default router;