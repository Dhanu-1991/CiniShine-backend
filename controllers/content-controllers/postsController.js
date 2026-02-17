/**
 * Posts Controller
 * Handles: post image init, create post, subscription posts
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Comment from '../../models/comment.model.js';
import User from '../../models/user.model.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getCfUrl } from '../../config/cloudfront.js';
import { createUploadNotifications } from '../notification-controllers/notificationController.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Initialize post image upload (optional)
 */
export const postImageInit = async (req, res) => {
    try {
        const { fileName, fileType, hasImage } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'User not authenticated' });
        if (!hasImage) return res.json({ uploadUrl: null, fileId: null });
        if (!fileName || !fileType) return res.status(400).json({ error: 'fileName and fileType are required for image upload' });

        const fileId = new mongoose.Types.ObjectId();
        const key = `posts/images/${userId}/${fileId}_${fileName}`;

        const command = new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Post image upload initialized: ${fileId} for user ${userId}`);
        res.json({ uploadUrl, fileId: key, key });
    } catch (error) {
        console.error('❌ Error initializing post image upload:', error);
        res.status(500).json({ error: 'Failed to initialize image upload' });
    }
};

/**
 * Create a post
 */
export const createPost = async (req, res) => {
    try {
        const { title, description, postContent, tags, visibility, commentsEnabled, imageUrl, imageUrls } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'User not authenticated' });
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        if (!description && !postContent) return res.status(400).json({ error: 'Description or content is required' });

        const fileId = new mongoose.Types.ObjectId();
        const imageKeys = imageUrls && imageUrls.length > 0
            ? imageUrls.slice(0, 5)
            : (imageUrl ? [imageUrl] : []);

        const post = await Content.create({
            _id: fileId,
            contentType: 'post',
            userId,
            title: title.trim(),
            description: description || '',
            postContent: postContent || description || '',
            tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
            visibility: visibility || 'public',
            commentsEnabled: commentsEnabled !== false,
            imageKey: imageKeys[0] || null,
            imageKeys: imageKeys,
            status: 'completed',
            publishedAt: new Date()
        });

        // Notify subscribers about the new post
        createUploadNotifications(
            userId, post._id, 'post',
            post.title, post.imageKey
        ).catch(err => console.error('Notification error:', err));

        console.log(`✅ Post created: ${fileId} by user ${userId}`);
        res.json({
            success: true, message: 'Post created successfully', contentId: fileId,
            post: { _id: post._id, title: post.title, description: post.description, imageKey: post.imageKey, createdAt: post.createdAt }
        });
    } catch (error) {
        console.error('❌ Error creating post:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
};

/**
 * Get posts from user's subscriptions
 * Supports currentPostId (placed at index 0) and excludeIds for infinite scroll
 */
export const getSubscriptionPosts = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 10, currentPostId, excludeIds } = req.query;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId).select('subscriptions').lean();
        const subscribedIds = user?.subscriptions || [];

        const parsedLimit = parseInt(limit);
        const parsedPage = parseInt(page);

        // Build excludeIds set from query param
        const excludeIdSet = new Set();
        if (excludeIds) {
            excludeIds.split(',').filter(Boolean).forEach(id => excludeIdSet.add(id));
        }

        // If currentPostId on page 1, fetch it first
        let pinnedPost = null;
        if (currentPostId && parsedPage === 1) {
            try {
                pinnedPost = await Content.findById(currentPostId)
                    .populate('userId', 'userName channelName channelHandle channelPicture');
                if (pinnedPost) excludeIdSet.add(currentPostId);
            } catch (_) { /* ignore invalid ID */ }
        }

        // Build query — exclude already-loaded IDs
        let query;
        const baseFilter = {
            contentType: 'post', status: 'completed', visibility: 'public',
            ...(excludeIdSet.size > 0 && { _id: { $nin: Array.from(excludeIdSet) } })
        };

        if (subscribedIds.length > 0) {
            query = { ...baseFilter, userId: { $in: subscribedIds } };
        } else {
            query = baseFilter;
        }

        const skip = (parsedPage - 1) * parsedLimit;

        let [posts, total] = await Promise.all([
            Content.find(query).populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ createdAt: -1 }).skip(skip).limit(parsedLimit),
            Content.countDocuments(query)
        ]);

        // If subscription query returned nothing, fallback to all public posts
        if (posts.length === 0 && subscribedIds.length > 0) {
            const fallbackQuery = { ...baseFilter };
            delete fallbackQuery.userId;
            [posts, total] = await Promise.all([
                Content.find(fallbackQuery).populate('userId', 'userName channelName channelHandle channelPicture')
                    .sort({ createdAt: -1 }).skip(skip).limit(parsedLimit),
                Content.countDocuments(fallbackQuery)
            ]);
        }

        const postsWithUrls = await Promise.all(posts.map(post => formatPostWithUrls(post)));

        // Prepend pinned post at index 0 on page 1
        if (pinnedPost && parsedPage === 1) {
            const formatted = await formatPostWithUrls(pinnedPost);
            postsWithUrls.unshift(formatted);
        }

        res.json({
            posts: postsWithUrls,
            pagination: {
                currentPage: parsedPage,
                totalPages: Math.ceil(total / parsedLimit),
                totalItems: total,
                hasNextPage: skip + parsedLimit < total
            }
        });
    } catch (error) {
        console.error('❌ Error fetching subscription posts:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
    }
};

/**
 * Helper to format post with signed URLs
 */
async function formatPostWithUrls(post) {
    const thumbnailUrl = getCfUrl(post.thumbnailKey);
    const imageUrl = getCfUrl(post.imageKey);

    let imageUrls = [];
    if (post.imageKeys && post.imageKeys.length > 0) {
        imageUrls = (await Promise.all(post.imageKeys.map(key => getCfUrl(key)))).filter(Boolean);
    } else if (imageUrl) {
        imageUrls = [imageUrl];
    }

    const commentCount = await Comment.countDocuments({ videoId: post._id, onModel: 'Content', parentCommentId: null });

    return {
        _id: post._id, contentType: post.contentType, title: post.title,
        description: post.description, postContent: post.postContent,
        thumbnailUrl, imageUrl: imageUrl || thumbnailUrl, imageUrls,
        views: post.views, likeCount: post.likeCount || 0, commentCount,
        createdAt: post.createdAt,
        channelName: post.channelName || post.userId?.channelName || post.userId?.userName,
        channelHandle: post.userId?.channelHandle || null,
        channelPicture: post.userId?.channelPicture,
        userId: post.userId?._id || post.userId, tags: post.tags, visibility: post.visibility
    };
}
