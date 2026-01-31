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
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

        // Get user info for channel name
        const user = await User.findById(userId).select('channelName userName');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Generate unique file ID
        const fileId = new mongoose.Types.ObjectId();
        const key = `shorts/${userId}/${fileId}_${fileName}`;

        // Create content record
        const content = await Content.create({
            _id: fileId,
            contentType: 'short',
            userId,
            title: title || fileName,
            description: description || '',
            channelName: user.channelName || user.userName,
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

        // Get user info
        const user = await User.findById(userId).select('channelName userName');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `audio/${userId}/${fileId}_${fileName}`;

        // Create content record
        const content = await Content.create({
            _id: fileId,
            contentType: 'audio',
            userId,
            title: title || fileName,
            description: description || '',
            channelName: user.channelName || user.userName,
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

        // Get user info
        const user = await User.findById(userId).select('channelName userName');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const fileId = new mongoose.Types.ObjectId();

        // Create post content
        const post = await Content.create({
            _id: fileId,
            contentType: 'post',
            userId,
            title: title.trim(),
            description: description || '',
            postContent: postContent || description || '',
            channelName: user.channelName || user.userName,
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
        const thumbnailKey = `thumbnails/${userId}/${contentId}_thumb.${file.mimetype.split('/')[1] || 'jpg'}`;

        // Upload to S3
        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: thumbnailKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3Client.send(command);

        // Update content with thumbnail key
        await Content.findByIdAndUpdate(contentId, { thumbnailKey });

        console.log(`✅ Thumbnail uploaded for content: ${contentId}`);

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
                    { expiresIn: 3600 }
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
                    { expiresIn: 3600 }
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
                    { expiresIn: 3600 }
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
                            { expiresIn: 3600 }
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
                            { expiresIn: 3600 }
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
                            { expiresIn: 3600 }
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
                            { expiresIn: 3600 }
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
