import Comment from "../../models/comment.model.js";
import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import mongoose from "mongoose";

/**
 * Helper function to find content by ID
 * After migration, all content (videos, shorts, audio, posts) is in the Content model.
 * Returns { item, modelType } where modelType is always 'Content'
 */
async function findVideoOrContent(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return { item: null, modelType: null };
    }

    // All content now lives in the unified Content model
    const item = await Content.findById(id);
    if (item) {
        return { item, modelType: 'Content' };
    }

    return { item: null, modelType: null };
}

/**
 * POST /api/v2/video/:videoId/comments
 * POST /api/v2/content/:contentId/comments
 * Create a new comment (works for both videos and content)
 */
export const createComment = async (req, res) => {
    try {
        const { videoId } = req.params;
        const { text, parentCommentId } = req.body;
        const userId = req.user?.id;

        console.log(`💬 [Comment] Creating comment - videoId: ${videoId}, userId: ${userId}`);

        if (!userId) {
            console.log(`❌ [Comment] No userId - authentication required`);
            return res.status(401).json({ message: "Authentication required" });
        }

        if (!text || text.trim().length === 0) {
            console.log(`❌ [Comment] Empty comment text`);
            return res.status(400).json({ message: "Comment text is required" });
        }

        if (text.length > 5000) {
            console.log(`❌ [Comment] Comment too long`);
            return res.status(400).json({ message: "Comment is too long (max 5000 characters)" });
        }

        // Validate video/content exists - check both models
        const { item, modelType } = await findVideoOrContent(videoId);
        if (!item) {
            console.log(`❌ [Comment] Video/Content not found: ${videoId}`);
            return res.status(404).json({ message: "Video or content not found" });
        }

        console.log(`✅ [Comment] Found ${modelType}: ${videoId}`);

        // If reply, validate parent comment exists
        if (parentCommentId) {
            if (!mongoose.Types.ObjectId.isValid(parentCommentId)) {
                return res.status(400).json({ message: "Invalid parent comment ID" });
            }
            const parentComment = await Comment.findById(parentCommentId);
            if (!parentComment) {
                return res.status(404).json({ message: "Parent comment not found" });
            }
        }

        // Get user info (channelName for display, channelPicture for avatar)
        const user = await User.findById(userId).select("userName channelName channelPicture");
        if (!user) {
            console.log(`❌ [Comment] User not found: ${userId}`);
            return res.status(404).json({ message: "User not found" });
        }

        // Create comment with the model type
        const newComment = await Comment.create({
            videoId,
            onModel: modelType,
            userId,
            text: text.trim(),
            parentCommentId: parentCommentId || null
        });

        console.log(`✅ [Comment] Comment created: ${newComment._id}`);

        // If it's a reply, update parent's reply count
        if (parentCommentId) {
            await Comment.findByIdAndUpdate(
                parentCommentId,
                {
                    $push: { replies: newComment._id },
                    $inc: { replyCount: 1 }
                }
            );
            console.log(`✅ [Comment] Reply count updated for parent comment: ${parentCommentId}`);
        }
        // Note: commentCount is no longer stored - it's calculated from actual comments count

        // Return with current user data (channelName and channelPicture fetched live)
        res.status(201).json({
            message: "Comment created successfully",
            comment: {
                _id: newComment._id,
                videoId: newComment.videoId,
                userId: newComment.userId,
                userName: user.channelName || user.userName,
                userProfilePic: user.channelPicture || null,
                text: newComment.text,
                likeCount: 0,
                replyCount: 0,
                isEdited: false,
                createdAt: newComment.createdAt,
                userLiked: false
            }
        });
    } catch (error) {
        console.error("❌ [Comment] Error creating comment:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/v2/video/:videoId/comments?page=1&limit=20
 * GET /api/v2/content/:contentId/comments?page=1&limit=20
 * Get comments for a video or content (paginated, sorted by newest first)
 */
export const getComments = async (req, res) => {
    try {
        const { videoId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const userId = req.user?.id;

        console.log(`💬 [Comments] getComments called with params:`, { videoId, page, limit, allParams: req.params });

        if (!videoId) {
            console.error(`❌ [Comments] No videoId provided. req.params:`, req.params);
            return res.status(400).json({ message: "Video ID is required" });
        }

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            console.error(`❌ [Comments] Invalid video ID: ${videoId}`);
            return res.status(400).json({ message: "Invalid video ID" });
        }

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.max(1, Math.min(50, parseInt(limit))); // Max 50 per page
        const skip = (pageNum - 1) * limitNum;

        // Get top-level comments (no parent) and populate user data for live channelName & channelPicture
        const comments = await Comment.find({
            videoId,
            parentCommentId: null
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .select("-likes -userProfilePic")
            .populate({
                path: "userId",
                select: "userName channelName channelPicture"
            })
            .lean();

        // Get total count
        const total = await Comment.countDocuments({
            videoId,
            parentCommentId: null
        });

        // Get user's liked comment IDs for this page
        let userLikedCommentIds = [];
        if (userId) {
            userLikedCommentIds = await Comment.find(
                { _id: { $in: comments.map(c => c._id) }, likes: userId },
                { _id: 1 }
            ).lean();
            userLikedCommentIds = userLikedCommentIds.map(c => c._id.toString());
        }

        // Format response with live user data (channelName & channelPicture)
        const formattedComments = comments.map(comment => {
            const currentUser = comment.userId; // populated user object
            return {
                ...comment,
                userId: currentUser?._id || comment.userId, // restore userId as ID
                userName: currentUser?.channelName || currentUser?.userName || "Deleted User", // live fetch only
                userProfilePic: currentUser?.channelPicture || null, // only channelPicture, null if user deleted
                userLiked: userLikedCommentIds.includes(comment._id.toString())
            };
        });

        res.json({
            comments: formattedComments,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/v2/comments/:commentId/replies?page=1&limit=20
 * Get replies to a comment
 */
export const getCommentReplies = async (req, res) => {
    try {
        const { commentId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const userId = req.user?.id;

        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ message: "Invalid comment ID" });
        }

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.max(1, Math.min(50, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        // Get replies and populate user data for live channelName & channelPicture
        const replies = await Comment.find({
            parentCommentId: commentId
        })
            .sort({ createdAt: 1 }) // Oldest first for replies
            .skip(skip)
            .limit(limitNum)
            .select("-likes -userProfilePic")
            .populate({
                path: "userId",
                select: "userName channelName channelPicture"
            })
            .lean();

        const total = await Comment.countDocuments({
            parentCommentId: commentId
        });

        // Get user's liked reply IDs
        let userLikedReplyIds = [];
        if (userId) {
            userLikedReplyIds = await Comment.find(
                { _id: { $in: replies.map(r => r._id) }, likes: userId },
                { _id: 1 }
            ).lean();
            userLikedReplyIds = userLikedReplyIds.map(r => r._id.toString());
        }

        // Format response with live user data (channelName & channelPicture)
        const formattedReplies = replies.map(reply => {
            const currentUser = reply.userId; // populated user object
            return {
                ...reply,
                userId: currentUser?._id || reply.userId, // restore userId as ID
                userName: currentUser?.channelName || currentUser?.userName || "Deleted User", // live fetch only
                userProfilePic: currentUser?.channelPicture || null, // only channelPicture, null if user deleted
                userLiked: userLikedReplyIds.includes(reply._id.toString())
            };
        });

        res.json({
            replies: formattedReplies,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error("Error fetching replies:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * PUT /api/v2/comments/:commentId
 * Edit a comment (only by author)
 */
export const editComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const { text } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ message: "Comment text is required" });
        }

        if (text.length > 5000) {
            return res.status(400).json({ message: "Comment is too long (max 5000 characters)" });
        }

        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ message: "Comment not found" });
        }

        // Verify user is the author
        if (comment.userId.toString() !== userId) {
            return res.status(403).json({ message: "You can only edit your own comments" });
        }

        // Update comment
        comment.text = text.trim();
        comment.isEdited = true;
        comment.editedAt = new Date();
        await comment.save();

        res.json({
            message: "Comment updated successfully",
            comment: {
                _id: comment._id,
                text: comment.text,
                isEdited: comment.isEdited,
                editedAt: comment.editedAt
            }
        });
    } catch (error) {
        console.error("Error editing comment:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * DELETE /api/v2/comments/:commentId
 * Delete a comment (only by author or video owner)
 */
export const deleteComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user?.id;

        console.log(`🗑️ [Comment] Delete request - commentId: ${commentId}, userId: ${userId}`);

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ message: "Invalid comment ID" });
        }

        const comment = await Comment.findById(commentId);
        if (!comment) {
            console.log(`❌ [Comment] Comment not found: ${commentId}`);
            return res.status(404).json({ message: "Comment not found" });
        }

        console.log(`✅ [Comment] Found comment - videoId: ${comment.videoId}, onModel: ${comment.onModel}, author: ${comment.userId}`);

        // Get video/content to check if user is owner
        const { item: video } = await findVideoOrContent(comment.videoId);
        const isAuthor = comment.userId.toString() === userId;
        const isVideoOwner = video?.userId?.toString() === userId;

        console.log(`🔍 [Comment] isAuthor: ${isAuthor}, isVideoOwner: ${isVideoOwner}, contentFound: ${!!video}`);

        if (!isAuthor && !isVideoOwner) {
            return res.status(403).json({ message: "You cannot delete this comment" });
        }

        // If it's a reply, update parent's reply count
        if (comment.parentCommentId) {
            await Comment.findByIdAndUpdate(
                comment.parentCommentId,
                {
                    $pull: { replies: new mongoose.Types.ObjectId(commentId) },
                    $inc: { replyCount: -1 }
                }
            );
        } else {
            // If it's a top-level comment, delete all its replies
            await Comment.deleteMany({
                parentCommentId: new mongoose.Types.ObjectId(commentId)
            });
        }

        await Comment.findByIdAndDelete(commentId);
        console.log(`✅ [Comment] Comment deleted: ${commentId}`);

        res.json({ message: "Comment deleted successfully" });
    } catch (error) {
        console.error("❌ [Comment] Error deleting comment:", error.message, error.stack);
        res.status(500).json({ message: "Internal server error", detail: error.message });
    }
};

/**
 * POST /api/v2/comments/:commentId/like
 * Like/unlike a comment
 */
export const likeComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const userLikedIndex = comment.likes.indexOf(userId);

        if (userLikedIndex > -1) {
            // Unlike
            comment.likes.splice(userLikedIndex, 1);
            comment.likeCount = Math.max(0, comment.likeCount - 1);
        } else {
            // Like
            comment.likes.push(userId);
            comment.likeCount = (comment.likeCount || 0) + 1;
        }

        await comment.save();

        res.json({
            message: userLikedIndex > -1 ? "Comment unliked" : "Comment liked",
            liked: userLikedIndex === -1,
            likeCount: comment.likeCount
        });
    } catch (error) {
        console.error("Error liking comment:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * POST /api/v2/content/:videoId/comments/:commentId/reply
 * Create a reply to a comment
 */
export const replyToComment = async (req, res) => {
    try {
        const { videoId, commentId } = req.params;
        const { text } = req.body;
        const userId = req.user?.id;

        console.log(`💬 [Reply] Creating reply - videoId: ${videoId}, commentId: ${commentId}, userId: ${userId}`);

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ message: "Reply text is required" });
        }

        if (text.length > 5000) {
            return res.status(400).json({ message: "Reply is too long (max 5000 characters)" });
        }

        // Validate parent comment exists
        const parentComment = await Comment.findById(commentId);
        if (!parentComment) {
            return res.status(404).json({ message: "Parent comment not found" });
        }

        // Validate content exists
        const { item, modelType } = await findVideoOrContent(videoId);
        if (!item) {
            return res.status(404).json({ message: "Content not found" });
        }

        // Get user info
        const user = await User.findById(userId).select("userName channelName channelPicture");
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Create reply
        const newReply = await Comment.create({
            videoId,
            onModel: modelType,
            userId,
            text: text.trim(),
            parentCommentId: commentId
        });

        console.log(`✅ [Reply] Reply created: ${newReply._id}`);

        // Update parent comment's reply count
        await Comment.findByIdAndUpdate(
            commentId,
            {
                $push: { replies: newReply._id },
                $inc: { replyCount: 1 }
            }
        );

        // Note: Do NOT update commentCount for replies - only main comments count

        console.log(`✅ [Reply] Reply count updated for parent comment: ${commentId}`);

        res.status(201).json({
            message: "Reply created successfully",
            reply: {
                _id: newReply._id,
                videoId: newReply.videoId,
                userId: newReply.userId,
                userName: user.channelName || user.userName,
                userProfilePic: user.channelPicture || null,
                text: newReply.text,
                likeCount: 0,
                likes: 0,
                isEdited: false,
                createdAt: newReply.createdAt,
                userLiked: false,
                isLiked: false
            }
        });
    } catch (error) {
        console.error("❌ [Reply] Error creating reply:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};
