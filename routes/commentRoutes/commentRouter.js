import express from "express";
import {
    createComment,
    getComments,
    getCommentReplies,
    editComment,
    deleteComment,
    likeComment,
    replyToComment
} from "../../controllers/comment-controllers/commentController.js";
import { universalTokenVerifier, optionalTokenVerifier } from "../../controllers/auth-controllers/universalTokenVerifier.js";

const router = express.Router({ mergeParams: true });

// Comments on videos (optionalTokenVerifier to get userLiked status)
router.post("/", universalTokenVerifier, createComment);
router.get("/", optionalTokenVerifier, getComments);

// Comment replies (optionalTokenVerifier to get userLiked status)
router.get("/:commentId/replies", optionalTokenVerifier, getCommentReplies);
router.post("/:commentId/reply", universalTokenVerifier, replyToComment);

// Comment management
router.put("/:commentId", universalTokenVerifier, editComment);
router.delete("/:commentId", universalTokenVerifier, deleteComment);

// Comment likes
router.post("/:commentId/like", universalTokenVerifier, likeComment);
export default router;
