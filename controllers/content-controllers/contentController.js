/**
 * Content Controller
 * Handles: shorts, audio, posts
 * 
 * Endpoints:
 * - POST /api/v2/content/short/init    - Initialize short upload
 * - POST /api/v2/content/short/complete - Complete short upload
 * - POST /api/v2/content/audio/init    - Initialize audio upload
 * - POST /api/v2/content/audio/complete - Complete audio upload
 * - POST /api/v2/content/post/init     - Initialize post image upload
 * - POST /api/v2/content/post/create   - Create post
 * - POST /api/v2/content/:id/thumbnail - Upload custom thumbnail
 * - POST /api/v2/content/:id/watch-time - Track watch time for shorts/audio
 * - GET /api/v2/content/shorts         - Get shorts feed for shorts player
 * - GET /api/v2/content/audio/feed     - Get audio feed for audio player
 * - GET /api/v2/content/:id            - Get single content item
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';

// Cache for S3 object existence checks (TTL: 5 minutes)
const s3ExistenceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if an S3 object exists (with caching)
 */
async function s3ObjectExists(bucket, key) {
    const cacheKey = `${bucket}:${key}`;
    const cached = s3ExistenceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.exists;
    }

    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        s3ExistenceCache.set(cacheKey, { exists: true, timestamp: Date.now() });
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            s3ExistenceCache.set(cacheKey, { exists: false, timestamp: Date.now() });
            return false;
        }
        // For other errors, don't cache and assume it might exist
        console.error(`Error checking S3 object existence for ${key}:`, err.message);
        return true; // Optimistically return true to try generating URL
    }
}

/**
 * Generate signed URL only if object exists
 */
async function getSignedUrlIfExists(bucket, key, expiresIn = 3600) {
    if (!key) return null;

    const exists = await s3ObjectExists(bucket, key);
    if (!exists) {
        return null;
    }

    try {
        return await getSignedUrl(s3Client, new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }), { expiresIn });
    } catch (err) {
        console.error(`Error generating signed URL for ${key}:`, err.message);
        return null;
    }
}

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// ============================================
// SHORTS
// ============================================

/**
 * Initialize short video upload
 * Returns presigned URL for direct S3 upload
 */
export const shortUploadInit = async (req, res) => {
    try {
        const { fileName, fileType, title, description, tags, category, visibility, isAgeRestricted, commentsEnabled, selectedRoles, thumbnailOption } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!fileName || !fileType) {
            return res.status(400).json({ error: 'fileName and fileType are required' });
        }

        // Generate unique file ID
        const fileId = new mongoose.Types.ObjectId();
        const key = `shorts/${userId}/${fileId}_${fileName}`;

        // Create content record (channelName fetched via populate when needed)
        const content = await Content.create({
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

        // Generate presigned URL for upload
        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Short upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: fileId.toString(),
            key
        });
    } catch (error) {
        console.error('❌ Error initializing short upload:', error);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
};

/**
 * Complete short upload
 * Marks content as processing (triggers transcoding via worker)
 */
export const shortUploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize, title, description, tags, category, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!fileId) {
            return res.status(400).json({ error: 'fileId is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: 'Invalid file ID' });
        }

        const content = await Content.findById(fileId);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        if (content.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Update content with final metadata
        const updateData = {
            status: 'processing',
            fileSize: fileSize || 0,
            processingStart: new Date()
        };

        // Update optional fields if provided
        if (title) updateData.title = title;
        if (description) updateData.description = description;
        if (tags) updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
        if (category) updateData.category = category;
        if (visibility) updateData.visibility = visibility;
        if (typeof isAgeRestricted === 'boolean') updateData.isAgeRestricted = isAgeRestricted;
        if (typeof commentsEnabled === 'boolean') updateData.commentsEnabled = commentsEnabled;
        if (selectedRoles) updateData.selectedRoles = selectedRoles;

        await Content.findByIdAndUpdate(fileId, updateData);

        console.log(`✅ Short upload completed: ${fileId}`);

        res.json({
            success: true,
            message: 'Short uploaded successfully, processing started',
            contentId: fileId
        });
    } catch (error) {
        console.error('❌ Error completing short upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};

// ============================================
// AUDIO
// ============================================

/**
 * Initialize audio upload
 */
export const audioUploadInit = async (req, res) => {
    try {
        const { fileName, fileType, title, description, tags, category, audioCategory, artist, album, visibility, isAgeRestricted, commentsEnabled, selectedRoles } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!fileName || !fileType) {
            return res.status(400).json({ error: 'fileName and fileType are required' });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `audio/${userId}/${fileId}_${fileName}`;

        // Create content record (channelName fetched via populate when needed)
        const content = await Content.create({
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

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Audio upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: fileId.toString(),
            key
        });
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

        if (!fileId) {
            return res.status(400).json({ error: 'fileId is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: 'Invalid file ID' });
        }

        const content = await Content.findById(fileId);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        if (content.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Audio doesn't need transcoding like video, mark as completed
        const updateData = {
            status: 'completed',
            fileSize: fileSize || 0,
            duration: duration || 0,
            processingEnd: new Date()
        };

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

        console.log(`✅ Audio upload completed: ${fileId}`);

        res.json({
            success: true,
            message: 'Audio uploaded successfully',
            contentId: fileId
        });
    } catch (error) {
        console.error('❌ Error completing audio upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};

// ============================================
// POSTS
// ============================================

/**
 * Initialize post image upload (optional)
 * If post has an image, get presigned URL first
 */
export const postImageInit = async (req, res) => {
    try {
        const { fileName, fileType, hasImage } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!hasImage) {
            return res.json({ uploadUrl: null, fileId: null });
        }

        if (!fileName || !fileType) {
            return res.status(400).json({ error: 'fileName and fileType are required for image upload' });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `posts/images/${userId}/${fileId}_${fileName}`;

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        console.log(`📤 Post image upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: key, // Return the S3 key as fileId for posts
            key
        });
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

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }

        if (!description && !postContent) {
            return res.status(400).json({ error: 'Description or content is required' });
        }

        const fileId = new mongoose.Types.ObjectId();

        // Handle both single image (legacy) and multiple images
        const imageKeys = imageUrls && imageUrls.length > 0
            ? imageUrls.slice(0, 5) // Limit to 5 images
            : (imageUrl ? [imageUrl] : []);

        // Create post content (channelName fetched via populate when needed)
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
            imageKey: imageKeys[0] || null, // Legacy: first image
            imageKeys: imageKeys, // New: all images
            status: 'completed', // Posts are immediately completed
            publishedAt: new Date()
        });

        console.log(`✅ Post created: ${fileId} by user ${userId}`);

        res.json({
            success: true,
            message: 'Post created successfully',
            contentId: fileId,
            post: {
                _id: post._id,
                title: post.title,
                description: post.description,
                imageKey: post.imageKey,
                createdAt: post.createdAt
            }
        });
    } catch (error) {
        console.error('❌ Error creating post:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
};

// ============================================
// THUMBNAIL UPLOAD (for shorts/audio)
// ============================================

/**
 * Upload custom thumbnail for content
 */
export const uploadThumbnail = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        if (content.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Check if file was uploaded (via multer or similar)
        if (!req.file && !req.files?.thumbnail) {
            return res.status(400).json({ error: 'No thumbnail file provided' });
        }

        const file = req.file || req.files.thumbnail[0];

        // Determine thumbnail path based on content type
        const contentTypeFolder = content.contentType === 'short' ? 'shorts' : 'audio';
        const thumbnailKey = `thumbnails/${contentTypeFolder}/${userId}/${contentId}_thumb.${file.mimetype.split('/')[1] || 'jpg'}`;

        // Upload to S3
        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: thumbnailKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3Client.send(command);

        // Update content with thumbnail key and mark as custom
        await Content.findByIdAndUpdate(contentId, {
            thumbnailKey,
            thumbnailSource: 'custom'
        });

        console.log(`✅ Custom thumbnail uploaded for content: ${contentId}`);

        res.json({
            success: true,
            message: 'Thumbnail uploaded successfully',
            thumbnailKey
        });
    } catch (error) {
        console.error('❌ Error uploading thumbnail:', error);
        res.status(500).json({ error: 'Failed to upload thumbnail' });
    }
};

// ============================================
// GET CONTENT
// ============================================

/**
 * Get content by ID
 */
export const getContent = async (req, res) => {
    try {
        const { id: contentId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId)
            .populate('userId', 'userName channelName channelPicture profilePicture');

        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Generate signed URL for thumbnail if exists (with existence check)
        const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);

        // Generate signed URL for image (posts)
        const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);

        // Generate signed URL for audio file
        let audioUrl = null;
        if (content.contentType === 'audio' && content.originalKey) {
            audioUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.originalKey);
        }

        res.json({
            _id: content._id,
            contentType: content.contentType,
            title: content.title,
            description: content.description,
            postContent: content.postContent,
            duration: content.duration,
            thumbnailUrl,
            imageUrl,
            audioUrl,
            status: content.status,
            views: content.views,
            likeCount: content.likeCount,
            dislikeCount: content.dislikeCount,
            commentCount: content.commentCount,
            createdAt: content.createdAt,
            user: content.userId,
            channelName: content.channelName,
            tags: content.tags,
            category: content.category,
            audioCategory: content.audioCategory,
            artist: content.artist,
            album: content.album,
            visibility: content.visibility,
            commentsEnabled: content.commentsEnabled
        });
    } catch (error) {
        console.error('❌ Error fetching content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get user's content (shorts, audio, posts)
 */
export const getUserContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { type } = req.query; // Filter by content type

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const query = { userId };
        if (type && ['short', 'audio', 'post'].includes(type)) {
            query.contentType = type;
        }

        const contents = await Content.find(query)
            .sort({ createdAt: -1 })
            .select('contentType title description duration status thumbnailKey imageKey createdAt views likeCount');

        // Generate signed URLs for thumbnails/images
        const contentsWithUrls = await Promise.all(
            contents.map(async (content) => {
                const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
                const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);

                return {
                    _id: content._id,
                    contentType: content.contentType,
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    status: content.status,
                    thumbnailUrl,
                    imageUrl,
                    createdAt: content.createdAt,
                    views: content.views,
                    likeCount: content.likeCount
                };
            })
        );

        res.json(contentsWithUrls);
    } catch (error) {
        console.error('❌ Error fetching user content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get feed content (shorts, posts from subscriptions or trending)
 */
export const getFeedContent = async (req, res) => {
    try {
        const { type, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const query = {
            status: 'completed',
            visibility: 'public'
        };

        if (type && ['short', 'audio', 'post'].includes(type)) {
            query.contentType = type;
        } else {
            query.contentType = { $in: ['short', 'audio', 'post'] };
        }

        const contents = await Content.find(query)
            .populate('userId', 'userName channelName channelPicture')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await Content.countDocuments(query);

        // Generate URLs
        const contentsWithUrls = await Promise.all(
            contents.map(async (content) => {
                const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
                const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);

                return {
                    _id: content._id,
                    contentType: content.contentType,
                    title: content.title,
                    description: content.description,
                    postContent: content.postContent,
                    duration: content.duration,
                    thumbnailUrl,
                    imageUrl,
                    views: content.views,
                    likeCount: content.likeCount,
                    commentCount: content.commentCount,
                    createdAt: content.createdAt,
                    user: content.userId,
                    channelName: content.channelName
                };
            })
        );

        res.json({
            contents: contentsWithUrls,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                hasNextPage: skip + parseInt(limit) < total
            }
        });
    } catch (error) {
        console.error('❌ Error fetching feed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// ============================================
// WATCH TIME TRACKING FOR CONTENT (SHORTS/AUDIO)
// ============================================

/**
 * Track watch time for shorts and audio
 * Updates WatchHistory for recommendation algorithm
 */
export const updateContentWatchTime = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const { watchTime, totalDuration, sessionId } = req.body;
        const userId = req.user?.id;

        console.log(`⏱️ [WatchTime] Tracking - contentId: ${contentId}, userId: ${userId}, watchTime: ${watchTime}s, session: ${sessionId}`);

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            console.log(`❌ [WatchTime] Invalid content ID: ${contentId}`);
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId);
        if (!content) {
            console.log(`❌ [WatchTime] Content not found: ${contentId}`);
            return res.status(404).json({ error: 'Content not found' });
        }

        const watchPercentage = totalDuration > 0
            ? Math.min((watchTime / totalDuration) * 100, 100)
            : 0;
        const completedWatch = watchPercentage >= 90;

        console.log(`📊 [WatchTime] Stats - type: ${content.contentType}, percentage: ${watchPercentage.toFixed(1)}%, completed: ${completedWatch}`);

        // Update or create watch history for authenticated users
        if (userId) {
            const existingHistory = await WatchHistory.findOne({
                userId,
                contentId,
                contentType: content.contentType
            });

            if (existingHistory) {
                // Update existing history
                existingHistory.watchTime = Math.max(existingHistory.watchTime, watchTime);
                existingHistory.watchPercentage = Math.max(existingHistory.watchPercentage, watchPercentage);
                existingHistory.watchCount += 1;
                existingHistory.lastWatchedAt = new Date();

                if (completedWatch && !existingHistory.completedWatch) {
                    existingHistory.completedWatch = true;
                }

                // Add new session
                existingHistory.sessions.push({
                    sessionId,
                    watchTime,
                    watchPercentage,
                    startedAt: new Date(Date.now() - watchTime * 1000),
                    endedAt: new Date()
                });

                // Keep only last 10 sessions
                if (existingHistory.sessions.length > 10) {
                    existingHistory.sessions = existingHistory.sessions.slice(-10);
                }

                await existingHistory.save();
                console.log(`✅ [WatchTime] Updated existing history - watchCount: ${existingHistory.watchCount}`);
            } else {
                // Create new history record
                await WatchHistory.create({
                    userId,
                    contentId,
                    contentType: content.contentType,
                    watchTime,
                    watchPercentage,
                    completedWatch,
                    contentMetadata: {
                        title: content.title,
                        tags: content.tags,
                        category: content.category,
                        creatorId: content.userId,
                        thumbnailKey: content.thumbnailKey
                    },
                    sessions: [{
                        sessionId,
                        watchTime,
                        watchPercentage,
                        startedAt: new Date(Date.now() - watchTime * 1000),
                        endedAt: new Date()
                    }]
                });
                console.log(`✅ [WatchTime] Created new history record for user: ${userId}`);
            }
        }

        // Update content view count if watched for at least X seconds
        // Shorts: 3 seconds, Posts: 5 seconds, Audio: 5 seconds
        const viewThreshold = content.contentType === 'short' ? 3 : 5;

        if (watchTime >= viewThreshold) {
            // Increment view count
            const updatedContent = await Content.findByIdAndUpdate(
                contentId,
                { $inc: { views: 1 } },
                { new: true }
            );
            console.log(`👁️ [WatchTime] View counted for ${content.contentType}: ${contentId} - total views: ${updatedContent.views}`);
        }

        res.json({
            success: true,
            watchPercentage,
            completedWatch,
            message: 'Watch time updated'
        });
    } catch (error) {
        console.error('❌ Error updating watch time:', error);
        res.status(500).json({ error: 'Failed to update watch time' });
    }
};

/**
 * Update engagement signals (like, dislike, comment, share)
 * Also updates likeCount/dislikeCount on the Content model
 */
export const updateContentEngagement = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const { action, value } = req.body; // action: 'like', 'dislike', 'comment', 'share'
        const userId = req.user?.id;

        console.log(`📊 [Engagement] Action: ${action}, Value: ${value}, ContentId: ${contentId}, UserId: ${userId}`);

        if (!userId) {
            console.log(`❌ [Engagement] No userId - authentication required`);
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            console.log(`❌ [Engagement] Invalid content ID: ${contentId}`);
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId);
        if (!content) {
            console.log(`❌ [Engagement] Content not found: ${contentId}`);
            return res.status(404).json({ error: 'Content not found' });
        }

        // Get existing engagement from WatchHistory
        const existingHistory = await WatchHistory.findOne({ userId, contentId, contentType: content.contentType });
        const wasLiked = existingHistory?.liked || false;
        const wasDisliked = existingHistory?.disliked || false;

        // Update watch history with engagement
        const updateField = {};
        if (action === 'like') updateField.liked = value;
        if (action === 'dislike') updateField.disliked = value;
        if (action === 'comment') updateField.commented = true;
        if (action === 'share') updateField.shared = true;

        await WatchHistory.findOneAndUpdate(
            { userId, contentId, contentType: content.contentType },
            { $set: updateField },
            { upsert: true }
        );

        // Update like/dislike count on Content model
        const contentUpdate = {};
        if (action === 'like') {
            if (value && !wasLiked) {
                contentUpdate.$inc = { likeCount: 1 };
                // If was disliked, also remove dislike
                if (wasDisliked) {
                    contentUpdate.$inc.dislikeCount = -1;
                    await WatchHistory.findOneAndUpdate(
                        { userId, contentId },
                        { $set: { disliked: false } }
                    );
                }
            } else if (!value && wasLiked) {
                contentUpdate.$inc = { likeCount: -1 };
            }
        }
        if (action === 'dislike') {
            if (value && !wasDisliked) {
                contentUpdate.$inc = { dislikeCount: 1 };
                // If was liked, also remove like
                if (wasLiked) {
                    contentUpdate.$inc.likeCount = -1;
                    await WatchHistory.findOneAndUpdate(
                        { userId, contentId },
                        { $set: { liked: false } }
                    );
                }
            } else if (!value && wasDisliked) {
                contentUpdate.$inc = { dislikeCount: -1 };
            }
        }
        if (action === 'comment') {
            // Comment count is updated in commentController
        }

        if (contentUpdate.$inc) {
            await Content.findByIdAndUpdate(contentId, contentUpdate);
            console.log(`✅ [Engagement] Updated content counts:`, contentUpdate.$inc);
        }

        console.log(`✅ [Engagement] ${action} updated for content: ${contentId}`);
        res.json({ success: true, message: `${action} updated` });
    } catch (error) {
        console.error('❌ [Engagement] Error updating engagement:', error);
        res.status(500).json({ error: 'Failed to update engagement' });
    }
};

/**
 * Get engagement status for a content item (isLiked, isDisliked, isSubscribed)
 */
export const getContentEngagementStatus = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const userId = req.user?.id;

        console.log(`📊 [EngagementStatus] Fetching for ContentId: ${contentId}, UserId: ${userId}`);

        if (!userId) {
            return res.json({ isLiked: false, isDisliked: false, isSubscribed: false });
        }

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId).populate('userId', '_id');
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Check like/dislike status from WatchHistory
        const history = await WatchHistory.findOne({ userId, contentId });
        const isLiked = history?.liked || false;
        const isDisliked = history?.disliked || false;

        // Check subscription status
        const user = await User.findById(userId).select('subscriptions');
        const channelUserId = content.userId?._id || content.userId;
        const isSubscribed = user?.subscriptions?.includes(channelUserId.toString()) || false;

        console.log(`✅ [EngagementStatus] Result:`, { isLiked, isDisliked, isSubscribed });

        res.json({ isLiked, isDisliked, isSubscribed });
    } catch (error) {
        console.error('❌ [EngagementStatus] Error:', error);
        res.status(500).json({ error: 'Failed to get engagement status' });
    }
};

// ============================================
// SHORTS PLAYER FEED
// ============================================

/**
 * Get shorts feed for the shorts player (vertical scrolling)
 * Returns personalized recommendations based on watch history
 * Supports excludeIds to avoid duplicates on infinite scroll
 */
export const getShortsPlayerFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 10, currentShortId, excludeIds } = req.query;

        // Parse excludeIds from comma-separated string to array
        const excludeIdArray = excludeIds
            ? excludeIds.split(',').filter(id => mongoose.Types.ObjectId.isValid(id))
            : [];

        console.log(`📥 [ShortsPlayerFeed] Request - userId: ${userId}, page: ${page}, currentShortId: ${currentShortId}, excludeCount: ${excludeIdArray.length}`);

        // If starting from a specific short, fetch that first
        let startingShort = null;
        if (currentShortId && mongoose.Types.ObjectId.isValid(currentShortId)) {
            console.log(`📥 [ShortsPlayerFeed] Fetching starting short: ${currentShortId}`);

            const content = await Content.findById(currentShortId)
                .populate('userId', 'userName channelName channelPicture');

            if (content && content.contentType === 'short') {
                // Generate URLs for the starting short (with existence check)
                const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                const videoUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, videoKey);

                startingShort = {
                    _id: content._id,
                    contentType: 'short',
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl,
                    videoUrl,
                    views: content.views,
                    likeCount: content.likeCount || 0,
                    commentCount: content.commentCount || 0,
                    createdAt: content.createdAt,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId,
                    tags: content.tags
                };

                console.log(`✅ [ShortsPlayerFeed] Starting short found - views: ${content.views}, likes: ${content.likeCount}`);
            }
        }

        // Get recommendations (personalized if user is logged in)
        let shorts = [];
        // Combine currentShortId with frontend-provided excludeIds to avoid duplicates
        const allExcludeIds = [
            ...(currentShortId ? [currentShortId] : []),
            ...excludeIdArray
        ];

        if (userId) {
            console.log(`📥 [ShortsPlayerFeed] Getting personalized recommendations for user: ${userId}`);
            // Personalized recommendations
            const recommendations = await watchHistoryEngine.getRecommendations(
                userId,
                'short',
                { page: parseInt(page), limit: parseInt(limit), excludeIds: allExcludeIds }
            );
            shorts = recommendations.content;
            console.log(`✅ [ShortsPlayerFeed] Got ${shorts.length} personalized shorts`);
        } else {
            console.log(`📥 [ShortsPlayerFeed] Fetching default shorts (no user)`);
            // Fallback to popular/recent shorts
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public',
                _id: { $nin: allExcludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1, views: -1 })
                .skip(skip)
                .limit(parseInt(limit));

            shorts = await Promise.all(contents.map(async (content) => {
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                return {
                    _id: content._id,
                    contentType: 'short',
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey),
                    videoUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, videoKey),
                    views: content.views,
                    likeCount: content.likeCount || 0,
                    commentCount: content.commentCount || 0,
                    createdAt: content.createdAt,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId,
                    tags: content.tags
                };
            }));

            console.log(`✅ [ShortsPlayerFeed] Fetched ${shorts.length} default shorts`);
        }

        // Add starting short at the beginning if provided
        const allShorts = startingShort ? [startingShort, ...shorts] : shorts;

        const totalShorts = await Content.countDocuments({
            contentType: 'short',
            status: 'completed',
            visibility: 'public'
        });

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

// ============================================
// AUDIO PLAYER FEED
// ============================================

/**
 * Get audio feed for the audio player
 */
export const getAudioPlayerFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 20, currentAudioId } = req.query;

        // If starting from a specific audio, fetch that first
        let startingAudio = null;
        if (currentAudioId && mongoose.Types.ObjectId.isValid(currentAudioId)) {
            const content = await Content.findById(currentAudioId)
                .populate('userId', 'userName channelName channelPicture');

            if (content && content.contentType === 'audio') {
                startingAudio = await formatAudioContent(content);
            }
        }

        let audioList = [];
        const excludeIds = currentAudioId ? [currentAudioId] : [];

        if (userId) {
            const recommendations = await watchHistoryEngine.getRecommendations(
                userId,
                'audio',
                { page: parseInt(page), limit: parseInt(limit), excludeIds }
            );
            audioList = recommendations.content;
        } else {
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'audio',
                status: 'completed',
                visibility: 'public',
                _id: { $nin: excludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit));

            audioList = await Promise.all(contents.map(formatAudioContent));
        }

        const allAudio = startingAudio ? [startingAudio, ...audioList] : audioList;

        const totalAudio = await Content.countDocuments({
            contentType: 'audio',
            status: 'completed',
            visibility: 'public'
        });

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

/**
 * Helper function to format audio content with signed URLs
 */
async function formatAudioContent(content) {
    // Get thumbnail URL - use thumbnailKey first, then imageKey as fallback
    // Only generate URL if the object actually exists in S3
    const thumbnailKey = content.thumbnailKey || content.imageKey;
    const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, thumbnailKey);

    // Get audio URL
    const audioKey = content.processedKey || content.originalKey;
    const audioUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, audioKey);

    return {
        _id: content._id,
        contentType: 'audio',
        title: content.title,
        description: content.description,
        duration: content.duration,
        thumbnailUrl,
        audioUrl,
        views: content.views || 0,
        likeCount: content.likeCount || 0,
        commentCount: content.commentCount || 0,
        createdAt: content.createdAt,
        channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
        channelPicture: content.userId?.channelPicture,
        userId: content.userId?._id || content.userId,
        artist: content.artist,
        album: content.album,
        audioCategory: content.audioCategory,
        tags: content.tags
    };
}

// ============================================
// GET SINGLE CONTENT
// ============================================

/**
 * Get single content item by ID
 */
export const getSingleContent = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(id)
            .populate('userId', 'userName channelName channelPicture');

        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Generate URLs based on content type (with existence check)
        const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
        const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);
        let mediaUrl = null;

        // For posts with multiple images, generate URLs for all images
        let imageUrls = [];
        if (content.contentType === 'post' && content.imageKeys && content.imageKeys.length > 0) {
            imageUrls = await Promise.all(
                content.imageKeys.map(key => getSignedUrlIfExists(process.env.S3_BUCKET, key))
            );
            // Filter out nulls
            imageUrls = imageUrls.filter(url => url !== null);
        } else if (imageUrl) {
            imageUrls = [imageUrl];
        }

        if (content.contentType === 'short') {
            const videoKey = content.hlsKey || content.processedKey || content.originalKey;
            mediaUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, videoKey);
        } else if (content.contentType === 'audio') {
            const audioKey = content.processedKey || content.originalKey;
            mediaUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, audioKey);
        }

        res.json({
            _id: content._id,
            contentType: content.contentType,
            title: content.title,
            description: content.description,
            postContent: content.postContent,
            duration: content.duration,
            thumbnailUrl,
            imageUrl: imageUrl || thumbnailUrl,
            imageUrls: imageUrls, // Array of all image URLs for multi-image posts
            videoUrl: content.contentType === 'short' ? mediaUrl : null,
            audioUrl: content.contentType === 'audio' ? mediaUrl : null,
            views: content.views,
            likeCount: content.likeCount || 0,
            commentCount: content.commentCount || 0,
            createdAt: content.createdAt,
            channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
            channelPicture: content.userId?.channelPicture,
            userId: content.userId?._id || content.userId,
            tags: content.tags,
            category: content.category,
            artist: content.artist,
            album: content.album,
            audioCategory: content.audioCategory,
            visibility: content.visibility,
            status: content.status
        });
    } catch (error) {
        console.error('❌ Error fetching content:', error);
        res.status(500).json({ error: 'Failed to fetch content' });
    }
};

// ============================================
// GET SUBSCRIPTION POSTS
// ============================================

/**
 * Get posts from user's subscriptions
 * Returns posts from channels the user is subscribed to
 */
export const getSubscriptionPosts = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { currentPostId, page = 1, limit = 10 } = req.query;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        console.log(`📮 [SubscriptionPosts] Fetching for user: ${userId}, currentPost: ${currentPostId}`);

        // Get user's subscriptions
        const user = await User.findById(userId).select('subscriptions');
        const subscriptions = user?.subscriptions || [];

        if (subscriptions.length === 0) {
            // No subscriptions - return single post if currentPostId provided
            if (currentPostId && mongoose.Types.ObjectId.isValid(currentPostId)) {
                const singlePost = await Content.findOne({
                    _id: currentPostId,
                    contentType: 'post',
                    status: 'completed',
                    visibility: 'public'
                }).populate('userId', 'userName channelName channelPicture');

                if (singlePost) {
                    const postData = await formatPostWithUrls(singlePost);
                    return res.json({
                        posts: [postData],
                        currentIndex: 0,
                        pagination: { hasNextPage: false, totalItems: 1 }
                    });
                }
            }
            return res.json({
                posts: [],
                currentIndex: 0,
                pagination: { hasNextPage: false, totalItems: 0 }
            });
        }

        // Build query for subscription posts
        const query = {
            userId: { $in: subscriptions },
            contentType: 'post',
            status: 'completed',
            visibility: 'public'
        };

        // Get total count
        const total = await Content.countDocuments(query);

        // Get posts sorted by date
        let posts = await Content.find(query)
            .populate('userId', 'userName channelName channelPicture')
            .sort({ createdAt: -1 })
            .limit(100); // Get more to find current post index

        // Find current post index if provided
        let currentIndex = 0;
        if (currentPostId) {
            const idx = posts.findIndex(p => p._id.toString() === currentPostId);
            if (idx !== -1) {
                currentIndex = idx;
            } else {
                // Current post not in subscriptions - add it at the beginning
                const currentPost = await Content.findOne({
                    _id: currentPostId,
                    contentType: 'post',
                    status: 'completed',
                    visibility: 'public'
                }).populate('userId', 'userName channelName channelPicture');

                if (currentPost) {
                    posts = [currentPost, ...posts];
                    currentIndex = 0;
                }
            }
        }

        // Format posts with URLs
        const formattedPosts = await Promise.all(
            posts.map(post => formatPostWithUrls(post))
        );

        console.log(`✅ [SubscriptionPosts] Found ${formattedPosts.length} posts, currentIndex: ${currentIndex}`);

        res.json({
            posts: formattedPosts,
            currentIndex,
            pagination: {
                hasNextPage: posts.length < total,
                totalItems: total
            }
        });
    } catch (error) {
        console.error('❌ Error fetching subscription posts:', error);
        res.status(500).json({ error: 'Failed to fetch subscription posts' });
    }
};

/**
 * Helper to format post with signed URLs
 */
async function formatPostWithUrls(post) {
    const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, post.thumbnailKey);
    const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, post.imageKey);

    // Handle multiple images
    let imageUrls = [];
    if (post.imageKeys && post.imageKeys.length > 0) {
        imageUrls = await Promise.all(
            post.imageKeys.map(key => getSignedUrlIfExists(process.env.S3_BUCKET, key))
        );
        imageUrls = imageUrls.filter(url => url !== null);
    } else if (imageUrl) {
        imageUrls = [imageUrl];
    }

    return {
        _id: post._id,
        contentType: post.contentType,
        title: post.title,
        description: post.description,
        postContent: post.postContent,
        thumbnailUrl,
        imageUrl: imageUrl || thumbnailUrl,
        imageUrls,
        views: post.views,
        likeCount: post.likeCount || 0,
        commentCount: post.commentCount || 0,
        createdAt: post.createdAt,
        channelName: post.channelName || post.userId?.channelName || post.userId?.userName,
        channelPicture: post.userId?.channelPicture,
        userId: post.userId?._id || post.userId,
        tags: post.tags,
        visibility: post.visibility
    };
}
