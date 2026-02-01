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
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';

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

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 86400 });

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

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 86400 });

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

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 86400 });

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
        const { title, description, postContent, tags, visibility, commentsEnabled, imageUrl } = req.body;
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
            imageKey: imageUrl || null, // S3 key if image was uploaded
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

        // Generate signed URL for thumbnail if exists
        let thumbnailUrl = null;
        if (content.thumbnailKey) {
            try {
                thumbnailUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.thumbnailKey,
                    }),
                    { expiresIn: 86400 }
                );
            } catch (err) {
                console.warn('Could not generate thumbnail URL:', err.message);
            }
        }

        // Generate signed URL for image (posts)
        let imageUrl = null;
        if (content.imageKey) {
            try {
                imageUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.imageKey,
                    }),
                    { expiresIn: 86400 }
                );
            } catch (err) {
                console.warn('Could not generate image URL:', err.message);
            }
        }

        // Generate signed URL for audio file
        let audioUrl = null;
        if (content.contentType === 'audio' && content.originalKey) {
            try {
                audioUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.originalKey,
                    }),
                    { expiresIn: 86400 }
                );
            } catch (err) {
                console.warn('Could not generate audio URL:', err.message);
            }
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
                let thumbnailUrl = null;
                let imageUrl = null;

                if (content.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: content.thumbnailKey,
                            }),
                            { expiresIn: 86400 }
                        );
                    } catch (err) {
                        console.warn('Thumbnail URL error:', err.message);
                    }
                }

                if (content.imageKey) {
                    try {
                        imageUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: content.imageKey,
                            }),
                            { expiresIn: 86400 }
                        );
                    } catch (err) {
                        console.warn('Image URL error:', err.message);
                    }
                }

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
                let thumbnailUrl = null;
                let imageUrl = null;

                if (content.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: content.thumbnailKey,
                            }),
                            { expiresIn: 86400 }
                        );
                    } catch (err) { /* ignore */ }
                }

                if (content.imageKey) {
                    try {
                        imageUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: content.imageKey,
                            }),
                            { expiresIn: 86400 }
                        );
                    } catch (err) { /* ignore */ }
                }

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

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        const watchPercentage = totalDuration > 0
            ? Math.min((watchTime / totalDuration) * 100, 100)
            : 0;
        const completedWatch = watchPercentage >= 90;

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
            }
        }

        // Update content view count if watched for at least 5 seconds
        // Use rate limiting for view count updates
        const viewThreshold = content.contentType === 'short' ? 3 : 5;

        if (watchTime >= viewThreshold) {
            // Check if this session already counted as a view
            const sessionKey = `content_view_${contentId}_${sessionId || 'anon'}`;
            const viewCounted = req.headers['x-view-counted'];

            if (!viewCounted) {
                await Content.findByIdAndUpdate(contentId, {
                    $inc: { views: 1 }
                });
            }
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
 */
export const updateContentEngagement = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const { action, value } = req.body; // action: 'like', 'dislike', 'comment', 'share'
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

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

        res.json({ success: true, message: `${action} updated` });
    } catch (error) {
        console.error('❌ Error updating engagement:', error);
        res.status(500).json({ error: 'Failed to update engagement' });
    }
};

// ============================================
// SHORTS PLAYER FEED
// ============================================

/**
 * Get shorts feed for the shorts player (vertical scrolling)
 * Returns personalized recommendations based on watch history
 */
export const getShortsPlayerFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 10, currentShortId } = req.query;

        // If starting from a specific short, fetch that first
        let startingShort = null;
        if (currentShortId && mongoose.Types.ObjectId.isValid(currentShortId)) {
            const content = await Content.findById(currentShortId)
                .populate('userId', 'userName channelName channelPicture');

            if (content && content.contentType === 'short') {
                // Generate URLs for the starting short
                const thumbnailUrl = content.thumbnailKey
                    ? await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.thumbnailKey,
                    }), { expiresIn: 86400 })
                    : null;

                const videoUrl = content.hlsKey || content.processedKey || content.originalKey
                    ? await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.hlsKey || content.processedKey || content.originalKey,
                    }), { expiresIn: 86400 })
                    : null;

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
            }
        }

        // Get recommendations (personalized if user is logged in)
        let shorts = [];
        const excludeIds = currentShortId ? [currentShortId] : [];

        if (userId) {
            // Personalized recommendations
            const recommendations = await watchHistoryEngine.getRecommendations(
                userId,
                'short',
                { page: parseInt(page), limit: parseInt(limit), excludeIds }
            );
            shorts = recommendations.content;
        } else {
            // Fallback to popular/recent shorts
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public',
                _id: { $nin: excludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1, views: -1 })
                .skip(skip)
                .limit(parseInt(limit));

            shorts = await Promise.all(contents.map(async (content) => ({
                _id: content._id,
                contentType: 'short',
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: content.thumbnailKey
                    ? await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.thumbnailKey,
                    }), { expiresIn: 86400 })
                    : null,
                videoUrl: content.hlsKey || content.processedKey || content.originalKey
                    ? await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: content.hlsKey || content.processedKey || content.originalKey,
                    }), { expiresIn: 86400 })
                    : null,
                views: content.views,
                likeCount: content.likeCount || 0,
                commentCount: content.commentCount || 0,
                createdAt: content.createdAt,
                channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                channelPicture: content.userId?.channelPicture,
                userId: content.userId?._id || content.userId,
                tags: content.tags
            })));
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
    let thumbnailUrl = null;
    const thumbnailKey = content.thumbnailKey || content.imageKey;
    if (thumbnailKey) {
        try {
            thumbnailUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: thumbnailKey,
            }), { expiresIn: 86400 }); // 24 hours
        } catch (err) {
            console.error('Error generating thumbnail URL:', err);
        }
    }

    // Get audio URL
    let audioUrl = null;
    const audioKey = content.processedKey || content.originalKey;
    if (audioKey) {
        try {
            audioUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: audioKey,
            }), { expiresIn: 86400 });
        } catch (err) {
            console.error('Error generating audio URL:', err);
        }
    }

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

        // Generate URLs based on content type
        let thumbnailUrl = null;
        let mediaUrl = null;
        let imageUrl = null;

        if (content.thumbnailKey) {
            thumbnailUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: content.thumbnailKey,
            }), { expiresIn: 86400 });
        }

        if (content.imageKey) {
            imageUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: content.imageKey,
            }), { expiresIn: 86400 });
        }

        if (content.contentType === 'short') {
            const videoKey = content.hlsKey || content.processedKey || content.originalKey;
            if (videoKey) {
                mediaUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                    Bucket: process.env.S3_BUCKET,
                    Key: videoKey,
                }), { expiresIn: 86400 });
            }
        } else if (content.contentType === 'audio') {
            const audioKey = content.processedKey || content.originalKey;
            if (audioKey) {
                mediaUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                    Bucket: process.env.S3_BUCKET,
                    Key: audioKey,
                }), { expiresIn: 86400 });
            }
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
// MIXED FEED (YouTube-style interleaved)
// ============================================

/**
 * Get mixed feed with interleaved shorts, audio, and posts
 * Mimics YouTube's feed pattern: alternates between content types
 */
export const getMixedFeed = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const userId = req.user?.id;

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.max(1, Math.min(50, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        // Get all content types with status 'completed'
        const allContent = await Content.find({
            status: 'completed',
            visibility: 'public'
        })
            .populate('userId', 'userName channelName channelPicture roles')
            .sort({ createdAt: -1 })
            .lean();

        // Format content with signed URLs
        const formattedContent = await Promise.all(
            allContent.map(async (content) => {
                let thumbnailUrl = null;
                let mediaUrl = null;
                let imageUrl = null;

                // Thumbnail
                const thumbnailKey = content.thumbnailKey || content.imageKey;
                if (thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: thumbnailKey,
                            }),
                            { expiresIn: 86400 }
                        );
                    } catch (err) {
                        console.error('Error generating thumbnail URL:', err);
                    }
                }

                // Media URL based on content type
                if (content.contentType === 'short') {
                    const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                    if (videoKey) {
                        try {
                            mediaUrl = await getSignedUrl(
                                s3Client,
                                new GetObjectCommand({
                                    Bucket: process.env.S3_BUCKET,
                                    Key: videoKey,
                                }),
                                { expiresIn: 86400 }
                            );
                        } catch (err) {
                            console.error('Error generating video URL:', err);
                        }
                    }
                } else if (content.contentType === 'audio') {
                    const audioKey = content.processedKey || content.originalKey;
                    if (audioKey) {
                        try {
                            mediaUrl = await getSignedUrl(
                                s3Client,
                                new GetObjectCommand({
                                    Bucket: process.env.S3_BUCKET,
                                    Key: audioKey,
                                }),
                                { expiresIn: 86400 }
                            );
                        } catch (err) {
                            console.error('Error generating audio URL:', err);
                        }
                    }
                } else if (content.contentType === 'post') {
                    if (content.imageKey) {
                        try {
                            imageUrl = await getSignedUrl(
                                s3Client,
                                new GetObjectCommand({
                                    Bucket: process.env.S3_BUCKET,
                                    Key: content.imageKey,
                                }),
                                { expiresIn: 86400 }
                            );
                        } catch (err) {
                            console.error('Error generating image URL:', err);
                        }
                    }
                }

                return {
                    _id: content._id,
                    contentType: content.contentType,
                    title: content.title,
                    description: content.description,
                    postContent: content.postContent,
                    duration: content.duration,
                    thumbnailUrl: thumbnailUrl || imageUrl,
                    imageUrl,
                    videoUrl: content.contentType === 'short' ? mediaUrl : null,
                    audioUrl: content.contentType === 'audio' ? mediaUrl : null,
                    views: content.views || 0,
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
                    audioCategory: content.audioCategory
                };
            })
        );

        // Interleave content types in YouTube-like pattern:
        // Pattern: short, video, audio, post, short, video, audio, post...
        const typePattern = ['short', 'video', 'audio', 'post'];
        const interleavedContent = [];
        const contentByType = {
            short: formattedContent.filter(c => c.contentType === 'short'),
            video: formattedContent.filter(c => c.contentType === 'video'),
            audio: formattedContent.filter(c => c.contentType === 'audio'),
            post: formattedContent.filter(c => c.contentType === 'post')
        };

        // Interleave based on pattern until we have enough or run out
        let indices = { short: 0, video: 0, audio: 0, post: 0 };
        let patternIndex = 0;

        while (
            interleavedContent.length < formattedContent.length &&
            (indices.short < contentByType.short.length ||
                indices.video < contentByType.video.length ||
                indices.audio < contentByType.audio.length ||
                indices.post < contentByType.post.length)
        ) {
            const contentType = typePattern[patternIndex % typePattern.length];
            if (indices[contentType] < contentByType[contentType].length) {
                interleavedContent.push(contentByType[contentType][indices[contentType]]);
                indices[contentType]++;
            }
            patternIndex++;
        }

        // Apply pagination
        const paginatedContent = interleavedContent.slice(skip, skip + limitNum);
        const totalContent = interleavedContent.length;
        const hasNextPage = skip + limitNum < totalContent;

        res.json({
            content: paginatedContent,
            shorts: paginatedContent.filter(c => c.contentType === 'short'),
            audio: paginatedContent.filter(c => c.contentType === 'audio'),
            videos: paginatedContent.filter(c => c.contentType === 'video'),
            posts: paginatedContent.filter(c => c.contentType === 'post'),
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: totalContent,
                hasNextPage,
                pages: Math.ceil(totalContent / limitNum)
            }
        });
    } catch (error) {
        console.error('❌ Error fetching mixed feed:', error);
        res.status(500).json({ error: 'Failed to fetch mixed feed' });
    }
};
