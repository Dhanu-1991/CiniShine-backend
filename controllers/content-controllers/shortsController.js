/**
 * Shorts Controller
 * Handles: short upload init/complete, shorts player feed
 * Extracted from the old monolithic contentController.js
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Comment from '../../models/comment.model.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { createUploadNotifications } from '../notification-controllers/notificationController.js';
import { getCfUrl } from '../../config/cloudfront.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Initialize short video upload
 */
export const shortUploadInit = async (req, res) => {
    try {
        const { fileName, fileType, title, description, tags, category, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'User not authenticated' });
        if (!fileName || !fileType) return res.status(400).json({ error: 'fileName and fileType are required' });

        const fileId = new mongoose.Types.ObjectId();
        const key = `shorts/${userId}/${fileId}_${fileName}`;

        await Content.create({
            _id: fileId,
            contentType: 'short',
            userId,
            title: title || fileName,
            description: description || '',
            tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
            category: category || '',
            visibility: visibility || 'public',
            isAgeRestricted: isAgeRestricted || false,
            commentsEnabled: commentsEnabled !== false,
            selectedRoles: selectedRoles || [],
            originalKey: key,
            mimeType: fileType,
            status: 'uploading'
        });

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Short upload initialized: ${fileId} for user ${userId}`);
        res.json({ uploadUrl, fileId: fileId.toString(), key });
    } catch (error) {
        console.error('❌ Error initializing short upload:', error);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
};

/**
 * Complete short upload
 */
export const shortUploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize, title, description, tags, category, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!fileId) return res.status(400).json({ error: 'fileId is required' });
        if (!mongoose.Types.ObjectId.isValid(fileId)) return res.status(400).json({ error: 'Invalid file ID' });

        const content = await Content.findById(fileId);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });

        const updateData = { status: 'completed', fileSize: fileSize || 0, processingStart: new Date(), publishedAt: new Date() };
        if (title) updateData.title = title;
        if (description) updateData.description = description;
        if (tags) updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
        if (category) updateData.category = category;
        if (visibility) updateData.visibility = visibility;
        if (typeof isAgeRestricted === 'boolean') updateData.isAgeRestricted = isAgeRestricted;
        if (typeof commentsEnabled === 'boolean') updateData.commentsEnabled = commentsEnabled;
        if (selectedRoles) updateData.selectedRoles = selectedRoles;

        await Content.findByIdAndUpdate(fileId, updateData);

        // Notify subscribers about the new short
        createUploadNotifications(
            content.userId, fileId, 'short',
            updateData.title || content.title, content.thumbnailKey
        ).catch(err => console.error('Notification error:', err));

        console.log(`✅ Short upload completed: ${fileId}`);
        res.json({ success: true, message: 'Short uploaded successfully, processing started', contentId: fileId });
    } catch (error) {
        console.error('❌ Error completing short upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};

// Helper to batch fetch comment counts
async function attachCommentCounts(contents) {
    const contentIds = contents.map(c => c._id);
    const commentCounts = await Comment.aggregate([
        { $match: { videoId: { $in: contentIds }, onModel: 'Content', parentCommentId: null } },
        { $group: { _id: '$videoId', count: { $sum: 1 } } }
    ]);
    const countMap = new Map(commentCounts.map(item => [item._id.toString(), item.count]));
    return contents.map(content => ({ ...content, commentCount: countMap.get(content._id.toString()) || 0 }));
}

/**
 * Get shorts feed for the shorts player (vertical scrolling)
 */
export const getShortsPlayerFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 10, currentShortId, excludeIds } = req.query;

        const excludeIdArray = excludeIds
            ? excludeIds.split(',').filter(id => mongoose.Types.ObjectId.isValid(id))
            : [];

        let startingShort = null;
        if (currentShortId && mongoose.Types.ObjectId.isValid(currentShortId)) {
            const content = await Content.findById(currentShortId)
                .populate('userId', 'userName channelName channelHandle channelPicture');

            if (content && content.contentType === 'short') {
                const thumbnailUrl = getCfUrl(content.thumbnailKey);
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                const videoUrl = getCfUrl(videoKey);
                const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });

                startingShort = {
                    _id: content._id, contentType: 'short', title: content.title, description: content.description,
                    duration: content.duration, thumbnailUrl, videoUrl, views: content.views,
                    likeCount: content.likeCount || 0, commentCount, createdAt: content.createdAt,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelHandle: content.userId?.channelHandle || null,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId, tags: content.tags
                };
            }
        }

        let shorts = [];
        const allExcludeIds = [...(currentShortId ? [currentShortId] : []), ...excludeIdArray];

        if (userId) {
            const recommendations = await watchHistoryEngine.getRecommendations(
                userId, 'short', { page: parseInt(page), limit: parseInt(limit), excludeIds: allExcludeIds }
            );
            shorts = recommendations.content || [];

            // Fallback: if algorithm returned nothing, fetch latest shorts
            if (shorts.length === 0) {
                const skip = (parseInt(page) - 1) * parseInt(limit);
                const contents = await Content.find({
                    contentType: 'short', status: { $in: ['completed', 'processing'] }, visibility: 'public',
                    _id: { $nin: allExcludeIds.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id)) }
                })
                    .populate('userId', 'userName channelName channelHandle channelPicture')
                    .sort({ createdAt: -1, views: -1 })
                    .skip(skip).limit(parseInt(limit));

                shorts = await Promise.all(contents.map(async (content) => {
                    const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                    const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
                    return {
                        _id: content._id, contentType: 'short', title: content.title, description: content.description,
                        duration: content.duration,
                        thumbnailUrl: getCfUrl(content.thumbnailKey),
                        videoUrl: getCfUrl(videoKey),
                        views: content.views, likeCount: content.likeCount || 0, commentCount,
                        channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                        channelHandle: content.userId?.channelHandle || null,
                        channelPicture: content.userId?.channelPicture,
                        userId: content.userId?._id || content.userId, tags: content.tags
                    };
                }));
            }
        } else {
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'short', status: { $in: ['completed', 'processing'] }, visibility: 'public',
                _id: { $nin: allExcludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ createdAt: -1, views: -1 })
                .skip(skip).limit(parseInt(limit));

            shorts = await Promise.all(contents.map(async (content) => {
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
                return {
                    _id: content._id, contentType: 'short', title: content.title, description: content.description,
                    duration: content.duration,
                    thumbnailUrl: getCfUrl(content.thumbnailKey),
                    videoUrl: getCfUrl(videoKey),
                    views: content.views, likeCount: content.likeCount || 0, commentCount,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelHandle: content.userId?.channelHandle || null,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId, tags: content.tags
                };
            }));
        }

        const allShorts = startingShort ? [startingShort, ...shorts] : shorts;
        const totalShorts = await Content.countDocuments({ contentType: 'short', status: { $in: ['completed', 'processing'] }, visibility: 'public' });

        res.json({
            shorts: allShorts,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalShorts / parseInt(limit)),
                totalItems: totalShorts,
                hasNextPage: parseInt(page) * parseInt(limit) < totalShorts
            }
        });
    } catch (error) {
        console.error('❌ Error fetching shorts feed:', error);
        res.status(500).json({ error: 'Failed to fetch shorts' });
    }
};
