import express from "express";
import { getVideo } from "../../controllers/video-controllers/getVideo.js";
import { getVideoStatus } from "../../controllers/video-controllers/getVideo.js";
import { uploadComplete } from "../../controllers/video-controllers/getVideo.js";
import { uploadInit } from "../../controllers/video-controllers/getVideo.js";
import {universalTokenVerifier} from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router();

router.get("/video/:id", universalTokenVerifier, getVideo);
router.get("/video/:id/status", universalTokenVerifier, getVideoStatus);
router.post("/video/upload/complete", universalTokenVerifier, uploadComplete);
router.post("/video/upload/init", universalTokenVerifier, uploadInit);

export default router;
