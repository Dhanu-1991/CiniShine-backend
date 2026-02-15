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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { getCfUrl } from '../../config/cloudfront.js';

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

        console.log(`ðŸ“¤ Short upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: fileId.toString(),
            key
        });
    } catch (error) {
        console.error('âŒ Error initializing short upload:', error);
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

        console.log(`âœ… Short upload completed: ${fileId}`);

        res.json({
            success: true,
            message: 'Short uploaded successfully, processing started',
            contentId: fileId
        });
    } catch (error) {
        console.error('âŒ Error completing short upload:', error);
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

        console.log(`ðŸ“¤ Audio upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: fileId.toString(),
            key
        });
    } catch (error) {
        console.error('âŒ Error initializing audio upload:', error);
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

        console.log(`âœ… Audio upload completed: ${fileId}`);

        res.json({
            success: true,
            message: 'Audio uploaded successfully',
            contentId: fileId
        });
    } catch (error) {
        console.error('âŒ Error completing audio upload:', error);
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

        console.log(`ðŸ“¤ Post image upload initialized: ${fileId} for user ${userId}`);

        res.json({
            uploadUrl,
            fileId: key, // Return the S3 key as fileId for posts
            key
        });
    } catch (error) {
        console.error('âŒ Error initializing post image upload:', error);
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

        console.log(`âœ… Post created: ${fileId} by user ${userId}`);

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
        console.error('âŒ Error creating post:', error);
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

        console.log(`âœ… Custom thumbnail uploaded for content: ${contentId}`);

        res.json({
            success: true,
            message: 'Thumbnail uploaded successfully',
            thumbnailKey
        });
    } catch (error) {
        console.error('âŒ Error uploading thumbnail:', error);
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
            .populate('userId', 'userName channelName channelHandle channelPicture profilePicture');

        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Block private content unless the requester is the owner
        if (content.visibility === 'private') {
            const requesterId = req.user?.id;
            const ownerId = content.userId?._id?.toString() || content.userId?.toString();
            if (!requesterId || requesterId !== ownerId) {
                return res.status(403).json({ error: 'This content is private' });
            }
        }

        // Generate signed URL for thumbnail if exists (with existence check)
        const thumbnailUrl = getCfUrl(content.thumbnailKey);

        // Generate signed URL for image (posts)
        const imageUrl = getCfUrl(content.imageKey);

        // Generate signed URL for audio file
        let audioUrl = null;
        if (content.contentType === 'audio' && content.originalKey) {
            audioUrl = getCfUrl(content.originalKey);
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
        console.error('âŒ Error fetching content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get user's content (shorts, audio, posts)
 */


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
            .populate('userId', 'userName channelName channelHandle channelPicture')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await Content.countDocuments(query);

        // Generate URLs
        const contentsWithUrls = await Promise.all(
            contents.map(async (content) => {
                const thumbnailUrl = getCfUrl(content.thumbnailKey);
                const imageUrl = getCfUrl(content.imageKey);

                // âœ… ADD: Get comment count
                const commentCount = await Comment.countDocuments({
                    videoId: content._id,
                    onModel: 'Content',
                    parentCommentId: { $exists: false }
                });

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
                    commentCount, // âœ… ADD
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
        console.error('âŒ Error fetching feed:', error);
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


/**
 * Update engagement signals (like, dislike, comment, share)
 * Also updates likeCount/dislikeCount on the Content model
 */


/**
 * Get engagement status for a content item (isLiked, isDisliked, isSubscribed)
    */

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

        console.log(`ðŸ“¥ [ShortsPlayerFeed] Request - userId: ${userId}, page: ${page}, currentShortId: ${currentShortId}, excludeCount: ${excludeIdArray.length}`);

        // If starting from a specific short, fetch that first
        let startingShort = null;
        if (currentShortId && mongoose.Types.ObjectId.isValid(currentShortId)) {
            console.log(`ðŸ“¥ [ShortsPlayerFeed] Fetching starting short: ${currentShortId}`);

            const content = await Content.findById(currentShortId)
                .populate('userId', 'userName channelName channelHandle channelPicture');

            if (content && content.contentType === 'short') {
                // Generate URLs for the starting short (with existence check)
                const thumbnailUrl = getCfUrl(content.thumbnailKey);
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;
                const videoUrl = getCfUrl(videoKey);

                // âœ… ADD: Get comment count for starting short
                const Comment = (await import('../../models/comment.model.js')).default;
                const commentCount = await Comment.countDocuments({
                    videoId: content._id,
                    onModel: 'Content',
                    parentCommentId: { $exists: false }
                });

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
                    commentCount, // âœ… ADD
                    createdAt: content.createdAt,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelHandle: content.userId?.channelHandle || null,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId,
                    tags: content.tags
                };

                console.log(`âœ… [ShortsPlayerFeed] Starting short found - views: ${content.views}, likes: ${content.likeCount}`);
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
            console.log(`ðŸ“¥ [ShortsPlayerFeed] Getting personalized recommendations for user: ${userId}`);
            // Personalized recommendations
            const recommendations = await watchHistoryEngine.getRecommendations(
                userId,
                'short',
                { page: parseInt(page), limit: parseInt(limit), excludeIds: allExcludeIds }
            );
            shorts = recommendations.content;
            console.log(`âœ… [ShortsPlayerFeed] Got ${shorts.length} personalized shorts`);
        } else {
            console.log(`ðŸ“¥ [ShortsPlayerFeed] Fetching default shorts (no user)`);
            // Fallback to popular/recent shorts
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const contents = await Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public',
                _id: { $nin: allExcludeIds.map(id => new mongoose.Types.ObjectId(id)) }
            })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ createdAt: -1, views: -1 })
                .skip(skip)
                .limit(parseInt(limit));

            // âœ… ADD: Import Comment model once at the top
            const Comment = (await import('../../models/comment.model.js')).default;

            shorts = await Promise.all(contents.map(async (content) => {
                const videoKey = content.hlsKey || content.processedKey || content.originalKey;

                // âœ… GET comment count for each short
                const commentCount = await Comment.countDocuments({
                    videoId: content._id,
                    onModel: 'Content',
                    parentCommentId: { $exists: false }
                });

                return {
                    _id: content._id,
                    contentType: 'short',
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl: getCfUrl(content.thumbnailKey),
                    videoUrl: getCfUrl(videoKey),
                    views: content.views,
                    likeCount: content.likeCount || 0,
                    commentCount, // âœ… ADD
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
                    channelHandle: content.userId?.channelHandle || null,
                    channelPicture: content.userId?.channelPicture,
                    userId: content.userId?._id || content.userId,
                    tags: content.tags
                };
            }));

            console.log(`âœ… [ShortsPlayerFeed] Fetched ${shorts.length} default shorts`);
        }

        // âœ… ADD: Attach comment counts for personalized shorts too (if using recommendations)
        if (userId && shorts.length > 0) {
            shorts = await attachCommentCounts(shorts);
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
        console.error('âŒ Error fetching shorts feed:', error);
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
                .populate('userId', 'userName channelName channelHandle channelPicture');

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
                .populate('userId', 'userName channelName channelHandle channelPicture')
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
        console.error('âŒ Error fetching audio feed:', error);
        res.status(500).json({ error: 'Failed to fetch audio' });
    }
};

/**
 * Helper function to format audio content with signed URLs
 */
async function formatAudioContent(content) {
    // âœ… ADD: Import Comment model
    const Comment = (await import('../../models/comment.model.js')).default;

    const thumbnailKey = content.thumbnailKey || content.imageKey;
    const thumbnailUrl = getCfUrl(thumbnailKey);
    const audioKey = content.processedKey || content.originalKey;
    const audioUrl = getCfUrl(audioKey);

    // âœ… ADD: Get comment count
    const commentCount = await Comment.countDocuments({
        videoId: content._id,
        onModel: 'Content',
        parentCommentId: { $exists: false }
    });

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
        commentCount, // âœ… ADD
        createdAt: content.createdAt,
        channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
        channelHandle: content.userId?.channelHandle || null,
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
            .populate('userId', 'userName channelName channelHandle channelPicture');

        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Block private content unless the requester is the owner
        if (content.visibility === 'private') {
            const requesterId = req.user?.id;
            const ownerId = content.userId?._id?.toString() || content.userId?.toString();
            if (!requesterId || requesterId !== ownerId) {
                return res.status(403).json({ error: 'This content is private' });
            }
        }

        // âœ… ADD: Get comment count
        const Comment = (await import('../../models/comment.model.js')).default;
        const commentCount = await Comment.countDocuments({
            videoId: content._id,
            onModel: 'Content',
            parentCommentId: { $exists: false }
        });

        // Generate URLs based on content type (with existence check)
        const thumbnailUrl = getCfUrl(content.thumbnailKey);
        const imageUrl = getCfUrl(content.imageKey);
        let mediaUrl = null;

        // For posts with multiple images, generate URLs for all images
        let imageUrls = [];
        if (content.contentType === 'post' && content.imageKeys && content.imageKeys.length > 0) {
            imageUrls = await Promise.all(
                content.imageKeys.map(key => getCfUrl(key))
            );
            // Filter out nulls
            imageUrls = imageUrls.filter(url => url !== null);
        } else if (imageUrl) {
            imageUrls = [imageUrl];
        }

        if (content.contentType === 'short') {
            const videoKey = content.hlsKey || content.processedKey || content.originalKey;
            mediaUrl = getCfUrl(videoKey);
        } else if (content.contentType === 'audio') {
            const audioKey = content.processedKey || content.originalKey;
            mediaUrl = getCfUrl(audioKey);
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
            commentCount, // âœ… ADD
            createdAt: content.createdAt,
            channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
            channelHandle: content.userId?.channelHandle || null,
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
        console.error('âŒ Error fetching content:', error);
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
/**
 * Helper to format post with signed URLs
 */
async function formatPostWithUrls(post) {
    // âœ… ADD: Import Comment model
    const Comment = (await import('../../models/comment.model.js')).default;

    const thumbnailUrl = getCfUrl(post.thumbnailKey);
    const imageUrl = getCfUrl(post.imageKey);

    let imageUrls = [];
    if (post.imageKeys && post.imageKeys.length > 0) {
        imageUrls = await Promise.all(
            post.imageKeys.map(key => getCfUrl(key))
        );
        imageUrls = imageUrls.filter(url => url !== null);
    } else if (imageUrl) {
        imageUrls = [imageUrl];
    }

    // âœ… ADD: Get comment count
    const commentCount = await Comment.countDocuments({
        videoId: post._id,
        onModel: 'Content',
        parentCommentId: { $exists: false }
    });

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
        commentCount, // âœ… ADD
        createdAt: post.createdAt,
        channelName: post.channelName || post.userId?.channelName || post.userId?.userName,
        channelHandle: post.userId?.channelHandle || null,
        channelPicture: post.userId?.channelPicture,
        userId: post.userId?._id || post.userId,
        tags: post.tags,
        visibility: post.visibility
    };
}

// Helper function to batch fetch comment counts
async function attachCommentCounts(contents) {
    const Comment = (await import('../../models/comment.model.js')).default;

    const contentIds = contents.map(c => c._id);

    // Single aggregation query instead of N queries
    const commentCounts = await Comment.aggregate([
        {
            $match: {
                videoId: { $in: contentIds },
                onModel: 'Content',
                parentCommentId: { $exists: false }
            }
        },
        {
            $group: {
                _id: '$videoId',
                count: { $sum: 1 }
            }
        }
    ]);

    // Create lookup map
    const countMap = new Map(
        commentCounts.map(item => [item._id.toString(), item.count])
    );

    // Attach counts to contents
    return contents.map(content => ({
        ...content,
        commentCount: countMap.get(content._id.toString()) || 0
    }));
}
