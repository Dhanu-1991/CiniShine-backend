/**
 * Audio Controller
 * Handles: audio upload init/complete, audio player feed
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Comment from '../../models/comment.model.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getCfUrl } from '../../../config/cloudfront.js';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { createUploadNotifications } from '../notification-controllers/notificationController.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Initialize audio upload
 */
export const audioUploadInit = async (req, res) => {
    try {
        const { fileName, fileType, title, description, tags, category, audioCategory, artist, album, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'User not authenticated' });
        if (!fileName || !fileType) return res.status(400).json({ error: 'fileName and fileType are required' });

        const fileId = new mongoose.Types.ObjectId();
        const key = `audio/${userId}/${fileId}_${fileName}`;

        await Content.create({
            _id: fileId,
            contentType: 'audio',
            userId,
            title: title || fileName,
            description: description || '',
            tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
            category: category || '',
            audioCategory: audioCategory || 'music',
            artist: artist || '',
            album: album || '',
            visibility: visibility || 'public',
            isAgeRestricted: isAgeRestricted || false,
            commentsEnabled: commentsEnabled !== false,
            selectedRoles: selectedRoles || [],
            originalKey: key,
            mimeType: fileType,
            status: 'uploading'
        });

        const command = new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Audio upload initialized: ${fileId} for user ${userId}`);
        res.json({ uploadUrl, fileId: fileId.toString(), key });
    } catch (error) {
        console.error('❌ Error initializing audio upload:', error);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
};

/**
 * Complete audio upload
 */
export const audioUploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize, duration, title, description, tags, category, audioCategory, artist, album, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!fileId) return res.status(400).json({ error: 'fileId is required' });
        if (!mongoose.Types.ObjectId.isValid(fileId)) return res.status(400).json({ error: 'Invalid file ID' });

        const content = await Content.findById(fileId);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });

        const updateData = { status: 'completed', fileSize: fileSize || 0, duration: duration || 0, processingEnd: new Date() };
        if (title) updateData.title = title;
        if (description) updateData.description = description;
        if (tags) updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
        if (category) updateData.category = category;
        if (audioCategory) updateData.audioCategory = audioCategory;
        if (artist) updateData.artist = artist;
        if (album) updateData.album = album;
        if (visibility) updateData.visibility = visibility;
        if (typeof isAgeRestricted === 'boolean') updateData.isAgeRestricted = isAgeRestricted;
        if (typeof commentsEnabled === 'boolean') updateData.commentsEnabled = commentsEnabled;
        if (selectedRoles) updateData.selectedRoles = selectedRoles;

        await Content.findByIdAndUpdate(fileId, updateData);

        // Notify subscribers about the new audio
        createUploadNotifications(
            content.userId, fileId, 'audio',
            updateData.title || content.title, content.thumbnailKey || content.imageKey
        ).catch(err => console.error('Notification error:', err));

        console.log(`✅ Audio upload completed: ${fileId}`);
        res.json({ success: true, message: 'Audio uploaded successfully', contentId: fileId });
    } catch (error) {
        console.error('❌ Error completing audio upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};

/**
 * Helper to format audio content with signed URLs
 */
async function formatAudioContent(content) {
    const thumbnailKey = content.thumbnailKey || content.imageKey;
    const thumbnailUrl = getCfUrl(thumbnailKey);
    const audioKey = content.processedKey || content.originalKey;
    const audioUrl = getCfUrl(audioKey);
    const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });

    return {
        _id: content._id, contentType: 'audio', title: content.title, description: content.description,
        duration: content.duration, thumbnailUrl, audioUrl, views: content.views || 0,
        likeCount: content.likeCount || 0, commentCount, createdAt: content.createdAt,
        channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
        channelHandle: content.userId?.channelHandle || null,
        channelPicture: content.userId?.channelPicture,
        userId: content.userId?._id || content.userId,
        artist: content.artist, album: content.album, audioCategory: content.audioCategory, tags: content.tags
    };
}

/**
 * Get audio feed for the audio player
 */
export const getAudioPlayerFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 20, currentAudioId, excludeIds: excludeIdsParam } = req.query;

        // Merge excludeIds from query param and currentAudioId
        const queryExcludeIds = excludeIdsParam
            ? excludeIdsParam.split(',').filter(id => mongoose.Types.ObjectId.isValid(id))
            : [];

        let startingAudio = null;
        if (currentAudioId && mongoose.Types.ObjectId.isValid(currentAudioId)) {
            const content = await Content.findById(currentAudioId).populate('userId', 'userName channelName channelHandle channelPicture');
            if (content && content.contentType === 'audio') {
                startingAudio = await formatAudioContent(content);
            }
        }

        let audioList = [];
        const allExcludeIds = [...(currentAudioId ? [currentAudioId] : []), ...queryExcludeIds];

        if (userId) {
            const recommendations = await watchHistoryEngine.getRecommendations(userId, 'audio', { page: parseInt(page), limit: parseInt(limit), excludeIds: allExcludeIds });
            audioList = recommendations.content || [];

            // Fallback: if algorithm returned nothing, fetch latest audio
            if (audioList.length === 0) {
                const skip = (parseInt(page) - 1) * parseInt(limit);
                const contents = await Content.find({
                    contentType: 'audio', status: 'completed', visibility: 'public',
                    _id: { $nin: allExcludeIds.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id)) }
                })
                    .populate('userId', 'userName channelName channelHandle channelPicture')
                    .sort({ createdAt: -1, views: -1 })
                    .skip(skip).limit(parseInt(limit));
                audioList = await Promise.all(contents.map(formatAudioContent));
            }
        } else {
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'audio', status: 'completed', visibility: 'public',
                _id: { $nin: allExcludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
            audioList = await Promise.all(contents.map(formatAudioContent));
        }

        const allAudio = startingAudio ? [startingAudio, ...audioList] : audioList;
        const totalAudio = await Content.countDocuments({ contentType: 'audio', status: 'completed', visibility: 'public' });

        res.json({
            audio: allAudio,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalAudio / parseInt(limit)),
                totalItems: totalAudio,
                hasNextPage: parseInt(page) * parseInt(limit) < totalAudio
            }
        });
    } catch (error) {
        console.error('❌ Error fetching audio feed:', error);
        res.status(500).json({ error: 'Failed to fetch audio' });
    }
};
