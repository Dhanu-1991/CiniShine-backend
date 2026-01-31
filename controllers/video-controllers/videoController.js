// controllers/video-controllers/videoController.js
import Video from "../../models/video.model.js";
import User from "../../models/user.model.js";
import VideoReaction from "../../models/videoReaction.model.js";
import Comment from "../../models/comment.model.js";
import mongoose from 'mongoose';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import stream from 'stream';
import { promisify } from 'util';
import { updateViews } from "./videoParameters.js";
import { recommendationEngine } from "../../algorithms/recommendationAlgorithm.js";

const pipeline = promisify(stream.pipeline);

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Helper to find HLS files in S3
async function findHLSFiles(videoId, userId) {
    try {
        const prefix = `hls/videos/${userId}/${videoId}/`;
        const command = new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET,
            Prefix: prefix,
        });
        const response = await s3Client.send(command);
        return response.Contents || [];
    } catch (error) {
        console.error('Error finding HLS files:', error);
        return [];
    }
}

// Helper function to get correct protocol (handles proxies/load balancers)
function getProtocol(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (forwardedProto) {
        return forwardedProto.split(',')[0].trim();
    }
    if (req.secure) {
        return 'https';
    }
    if (req.headers['x-forwarded-ssl'] === 'on') {
        return 'https';
    }
    return req.protocol;
}

// Get video metadata
export const getVideo = async (req, res) => {
    try {
        const videoId = req.params.id ?? req.params.videoId;
        console.log('📹 Fetching video metadata for ID:', videoId);

        const video = await Video.findById(videoId).populate('userId', 'userName channelName channelPicture');
        if (!video) {
            console.error('❌ Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        // Generate signed URL for thumbnail (optional)
        let thumbnailUrl = null;
        if (video.thumbnailKey) {
            try {
                thumbnailUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: video.thumbnailKey,
                    }),
                    { expiresIn: 3600 }
                );
            } catch (err) {
                console.warn('Could not create signed thumbnail URL:', err.message || err);
                thumbnailUrl = null;
            }
        }

        // Prepare renditions data
        const renditions = (video.renditions || []).map(rendition => ({
            _id: rendition._id,
            name: rendition.name,
            resolution: rendition.resolution,
            bitrate: rendition.bitrate,
            codecs: rendition.codecs
        }));

        console.log("_id : ", video._id,
            "title : ", video.title,
            "description : ", video.description,
            "duration : ", video.duration,
            "hlsMasterUrl : ", `/api/v2/video/${videoId}/master.m3u8`,
            "thumbnailUrl : ", thumbnailUrl,
            "renditions : ", renditions,
            "status : ", video.status,
            "createdAt : ", video.createdAt,
            "user : ", video.userId,
            "views : ", video.views,
            "channelName : ", video.userId.channelName
        );

        // Get subscriber count for the channel
        const subscriberCount = await User.countDocuments({
            subscriptions: video.userId._id
        });

        // Check if current user is subscribed (if authenticated)
        let isSubscribed = false;
        if (req.user?.id) {
            const currentUser = await User.findById(req.user.id);
            isSubscribed = currentUser?.subscriptions?.includes(video.userId._id) || false;
        }

        // Check if current user liked/disliked - O(log N) indexed lookup
        let userReaction = null;
        if (req.user?.id) {
            userReaction = await VideoReaction.findOne({
                videoId,
                userId: req.user.id
            }).select('type');
        }

        // Get comment count for the video (only top-level comments, not replies)
        const commentCount = await Comment.countDocuments({
            videoId,
            parentCommentId: null
        });

        res.json({
            _id: video._id,
            title: video.title,
            description: video.description,
            duration: video.duration,
            // point client to backend playlist route (backend will rewrite)
            hlsMasterUrl: `/api/v2/video/${videoId}/master.m3u8`,
            thumbnailUrl,
            renditions,
            status: video.status,
            createdAt: video.createdAt,
            user: video.userId,
            views: video.views,
            likes: video.likeCount || 0,
            dislikes: video.dislikeCount || 0,
            userReaction: userReaction?.type || null,
            channelName: video.userId?.channelName || 'Unknown', // Fetch from populated user
            subscriberCount,
            isSubscribed,
            channelPicture: video.userId?.channelPicture,
            commentCount,
            // Additional video metadata
            tags: video.tags || [],
            category: video.category || '',
            visibility: video.visibility || 'public',
            commentsEnabled: video.commentsEnabled !== false
        });

    } catch (error) {
        console.error('💥 Error fetching video data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Get HLS master playlist (rewritten to absolute backend variant URLs)
export const getHLSMasterPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        console.log('🎬 Serving master playlist for video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            console.error('❌ Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.status !== 'completed') {
            return res.status(423).json({
                error: 'Video is still processing',
                status: video.status
            });
        }

        if (!video.hlsMasterKey) {
            console.error('❌ No HLS master key found, searching...');
            const hlsFiles = await findHLSFiles(videoId, video.userId);
            const masterFile = hlsFiles.find(file => file.Key && file.Key.includes('master.m3u8'));
            if (!masterFile) {
                return res.status(404).json({ error: 'Master playlist not found' });
            }
            video.hlsMasterKey = masterFile.Key;
            await video.save();
        }

        // Fetch master playlist from S3 (signed URL)
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.hlsMasterKey,
            }),
            { expiresIn: 3600 }
        );
        console.log('🔑 Generated signed URL for master playlist:', signedUrl);
        const response = await fetch(signedUrl);
        if (!response.ok) {
            console.log("response not ok");
            throw new Error(`S3 responded with status: ${response.status}`);
        }

        let masterContent = await response.text();
        console.log('📄 Master playlist fetched, size:', masterContent.length, 'bytes');

        // Build absolute backend base (so HLS.js won't resolve against blob:)
        // Prefer X-Forwarded-Proto (set by proxies/load-balancers) or req.secure.
        // Falls back to req.protocol if neither is available.
        const protoHeader = req.headers['x-forwarded-proto'];
        const protocol = getProtocol(req);
        const backendBase = `${protocol}://${req.get('host')}`; // e.g. https://example.com

        // Rebuild master playlist: convert variant URIs to absolute backend variant endpoints
        const lines = masterContent.split(/\r?\n/);
        const rebuilt = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!line) {
                rebuilt.push(line);
                continue;
            }

            // keep comments/headers
            if (line.startsWith('#')) {
                rebuilt.push(line);

                // when EXT-X-STREAM-INF, next URI line is the variant reference
                if (line.startsWith('#EXT-X-STREAM-INF')) {
                    // find next non-empty, non-comment line
                    let j = i + 1;
                    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) {
                        if (lines[j].startsWith('#')) rebuilt.push(lines[j]);
                        j++;
                    }

                    if (j < lines.length) {
                        const variantPath = lines[j].trim();

                        // if absolute, keep it; otherwise map to backend variant endpoint
                        if (/^https?:\/\//i.test(variantPath) || variantPath.startsWith('//')) {
                            rebuilt.push(variantPath);
                        } else {
                            // try to infer quality
                            let quality = 'auto';
                            const pathMatch = variantPath.match(/stream[_\-]?(\d+)p/i);
                            if (pathMatch) {
                                quality = `${pathMatch[1]}p`;
                            } else {
                                const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
                                if (resMatch) quality = `${resMatch[2]}p`;
                            }

                            const variantFile = variantPath.split('/').pop();
                            const absoluteVariant = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(variantFile)}?quality=${encodeURIComponent(quality)}`;
                            console.log(`🔄 Master variant rewrite: ${variantPath} -> ${absoluteVariant}`);
                            rebuilt.push(absoluteVariant);
                        }

                        i = j; // skip the original variant line
                    }
                }
                continue;
            }

            // non-comment lines outside EXT-X-STREAM-INF context: keep absolute or convert to backend variants
            if (/^https?:\/\//i.test(line) || line.startsWith('//')) {
                rebuilt.push(line);
            } else {
                const variantFile = line.split('/').pop();
                const absoluteVariant = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(variantFile)}`;
                console.log(`🔄 Master other rewrite: ${line} -> ${absoluteVariant}`);
                rebuilt.push(absoluteVariant);
            }
        }

        const output = rebuilt.join('\n');

        // Set HLS headers
        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Master playlist served successfully');
        res.send(output);

    } catch (error) {
        console.error('💥 Error serving master playlist:', error);
        res.status(500).json({
            error: 'Failed to load video stream',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Get HLS variant playlist (robust key lookup + rewrite nested URIs to absolute backend URLs)
export const getHLSVariantPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        let variantFile = decodeURIComponent(req.params.variantFile || 'playlist.m3u8');
        if (variantFile.includes('?')) variantFile = variantFile.split('?')[0];
        const quality = req.query.quality ? String(req.query.quality).trim() : null;

        console.log('🎬 Serving variant:', variantFile, 'quality:', quality, 'video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ error: 'Video not found' });
        if (video.status !== 'completed') return res.status(423).json({ error: 'Video is still processing' });

        // Determine base path (folder containing master)
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/videos/${video.userId}/${videoId}/`;

        // build candidate S3 keys
        const q = quality && quality !== 'auto' ? (quality.endsWith('p') ? quality : `${quality}p`) : null;
        const candidates = [];

        if (q) {
            candidates.push(`${basePath}stream_${q}/variants/${variantFile}`);
            candidates.push(`${basePath}variants/stream_${q}/${variantFile}`);
            candidates.push(`${basePath}stream_${q}/${variantFile}`);
        }
        // fallback variants
        candidates.push(`${basePath}variants/${variantFile}`);
        candidates.push(`${basePath}${variantFile}`);

        console.log('🔍 Trying variant S3 keys:', candidates);

        let chosenKey = null;
        let variantContent = null;

        for (const key of candidates) {
            try {
                // create signed URL and try to fetch
                const signedUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
                    { expiresIn: 3600 }
                );

                const response = await fetch(signedUrl);
                if (response && response.ok) {
                    chosenKey = key;
                    variantContent = await response.text();
                    console.log('📄 Found variant at key:', key, 'size:', variantContent.length);
                    break;
                } else {
                    console.warn('⛔ Candidate not available:', key, response?.status);
                }
            } catch (err) {
                console.warn('⛔ Error trying candidate key:', key, err.message || err);
                // continue trying next candidate
            }
        }

        if (!variantContent) {
            console.error('❌ No variant playlist found in candidates');
            return res.status(404).json({ error: 'Variant playlist not found' });
        }

        // Rewrite nested playlist & segment URIs to absolute backend endpoints
        const protocol = getProtocol(req);
        const backendBase = `${protocol}://${req.get('host')}`;
        const qualityParam = quality && quality !== 'auto' ? `?quality=${encodeURIComponent(quality)}` : '';

        variantContent = variantContent.replace(
            /(^|[\r\n])([^#\r\n][^\r\n]*)/g,
            (match, prefix, uri) => {
                const trimmed = uri.trim();
                if (!trimmed) return match;

                // leave absolute URLs alone
                if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
                    return match;
                }

                // If this is a segment file
                if (/\.(ts|m4s|mp4|aac)$/i.test(trimmed)) {
                    const filename = trimmed.split('/').pop();
                    const backendUrl = `${backendBase}/api/v2/video/${videoId}/segments/${encodeURIComponent(filename)}${qualityParam}`;
                    console.log(`🔄 Segment rewrite: ${trimmed} -> ${backendUrl}`);
                    return `${prefix}${backendUrl}`;
                }

                // If this is another playlist file (.m3u8)
                if (trimmed.endsWith('.m3u8')) {
                    const filename = trimmed.split('/').pop();
                    const backendUrl = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(filename)}${qualityParam}`;
                    console.log(`🔁 Sub-playlist rewrite: ${trimmed} -> ${backendUrl}`);
                    return `${prefix}${backendUrl}`;
                }

                // Other URIs: leave as-is but ensure no leading blob path
                return `${prefix}${trimmed}`;
            }
        );

        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Variant served successfully (key):', chosenKey);
        res.send(variantContent);

    } catch (error) {
        console.error('💥 Error serving variant:', error);
        res.status(500).json({
            error: 'Failed to load video variant',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Get HLS segment (proxy from S3 instead of redirect)
export const getHLSSegment = async (req, res) => {
    try {
        const videoId = req.params.id; // route uses /video/:id/segments/:segmentFile
        let segmentFile = decodeURIComponent(req.params.segmentFile || '');
        if (segmentFile.includes('?')) segmentFile = segmentFile.split('?')[0];
        const quality = req.query.quality ? String(req.query.quality).trim() : null;

        console.log('🎬 Serving segment:', segmentFile, 'quality:', quality, 'video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        if (!segmentFile || !segmentFile.match(/\.(ts|m4s|mp4|aac)$/i)) {
            return res.status(400).json({ error: 'Invalid segment file' });
        }

        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ error: 'Video not found' });
        if (video.status !== 'completed') return res.status(423).json({ error: 'Video is still processing' });

        // Determine base path in S3
        const userId = video.userId;
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/videos/${userId}/${videoId}/`;

        // Candidate keys for segment
        const q = quality && quality !== 'auto' ? (quality.endsWith('p') ? quality : `${quality}p`) : null;
        const candidates = [];
        if (q) {
            candidates.push(`${basePath}stream_${q}/segments/${segmentFile}`);
            candidates.push(`${basePath}stream_${q}/${segmentFile}`);
        }
        candidates.push(`${basePath}segments/${segmentFile}`);
        candidates.push(`${basePath}${segmentFile}`);
        console.log('🔍 Trying segment keys:', candidates);

        // Support Range header for partial requests (important for fMP4 / big files)
        const rangeHeader = req.headers.range;

        let objResponse = null;
        let usedKey = null;

        for (const key of candidates) {
            try {
                const getCmdParams = {
                    Bucket: process.env.S3_BUCKET,
                    Key: key,
                    ...(rangeHeader ? { Range: rangeHeader } : {})
                };
                const getCmd = new GetObjectCommand(getCmdParams);
                objResponse = await s3Client.send(getCmd);
                usedKey = key;
                break;
            } catch (err) {
                const notFound = err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
                if (notFound) {
                    console.warn('Segment candidate not found:', key);
                    continue;
                }
                console.warn('S3 error while fetching segment candidate:', key, err.message || err);
            }
        }

        if (!objResponse) {
            console.error('❌ No segment found in candidates');
            return res.status(404).json({ error: 'Segment not found in storage' });
        }

        // Prepare headers - forward S3 metadata and range headers where present
        // If Range requested and S3 returned ContentRange, respond 206 Partial Content
        const isPartial = Boolean(rangeHeader) && Boolean(objResponse.ContentRange);
        if (isPartial) {
            res.status(206);
            if (objResponse.ContentRange) res.setHeader('Content-Range', objResponse.ContentRange);
        } else {
            res.status(200);
        }

        if (objResponse.ContentType) res.setHeader('Content-Type', objResponse.ContentType);
        if (objResponse.ContentLength) res.setHeader('Content-Length', String(objResponse.ContentLength));
        if (objResponse.ETag) res.setHeader('ETag', objResponse.ETag);
        if (objResponse.LastModified) res.setHeader('Last-Modified', new Date(objResponse.LastModified).toUTCString());
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        console.log('🔗 Proxying segment from S3 key:', usedKey, isPartial ? '(partial)' : '(full)');
        await pipeline(objResponse.Body, res);

    } catch (error) {
        console.error('💥 Error serving segment:', error);
        res.status(500).json({
            error: 'Failed to load video segment',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const getMyContent = async (req, res) => {
    try {
        const userId = req.user;
        console.log("🔍 Fetching videos for user:", userId);

        let userObjectId;
        if (mongoose.Types.ObjectId.isValid(userId)) {
            userObjectId = new mongoose.Types.ObjectId(userId);
        } else {
            userObjectId = userId;
        }

        const videos = await Video.find({ userId: userObjectId })
            .sort({ createdAt: -1 })
            .select('title description duration status thumbnailKey renditions createdAt tags');

        console.log("✅ Videos found:", videos.length);

        const videosWithUrls = await Promise.all(
            videos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: video.thumbnailKey,
                            }),
                            { expiresIn: 3600 }
                        );
                    } catch (s3Error) {
                        console.error('❌ Thumbnail error for video:', video._id);
                        thumbnailUrl = null;
                    }
                }

                return {
                    _id: video._id,
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    status: video.status,
                    thumbnailUrl,
                    tags: video.tags,
                    createdAt: video.createdAt,
                    renditions: video.renditions || [],
                    adaptiveStreaming: video.status === 'completed',
                    prefferedRendition: video.prefferedRendition || 'Auto'
                };
            })
        );

        res.json(videosWithUrls);
    } catch (error) {
        console.error('💥 Error fetching user videos:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export const getContent = async (req, res) => {
    try {
        console.log('🔍 Fetching recommended content for user');
        const userId = req.user?.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Get current user
        const user = await User.findById(userId);
        console.log("user found : ", user);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get user's own videos to exclude from recommendations
        const userVideos = await Video.find({ userId }).select('_id');

        // Get all completed videos with user info
        const allVideos = await Video.find({ status: 'completed' })
            .populate('userId', 'roles userName channelName channelPicture')
            .sort({ createdAt: -1 }); // Get recent videos first
        console.log("allVideos found : ", allVideos.length);
        // Get personalized recommendations
        const recommendedVideos = await recommendationEngine.getRecommendations(
            user,
            allVideos,
            userVideos,
            { limit: 100, excludeOwn: false } // Get more for better pagination, include own videos
        );
        console.log("recommendedVideos found : ", recommendedVideos.length);
        // Apply pagination to recommendations
        const paginatedVideos = recommendedVideos.slice(skip, skip + limit);

        // Generate thumbnail URLs for the videos
        const videosWithThumbnails = await Promise.all(
            paginatedVideos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: video.thumbnailKey,
                            }),
                            { expiresIn: 3600 }
                        );
                    } catch (error) {
                        console.error('Error generating thumbnail URL:', error);
                    }
                }

                return {
                    _id: video._id,
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    thumbnailUrl,
                    status: video.status,
                    views: video.views,
                    createdAt: video.createdAt,
                    user: {
                        _id: video.userId._id,
                        userName: video.userId.userName,
                        roles: video.userId.roles
                    },
                    recommendationScore: video.recommendationScore,// Optional: for debugging
                    channelName: video.userId?.channelName,
                    channelPicture: video.userId?.channelPicture || null
                };
            })
        );
        console.log("videosWithThumbnails prepared : ", videosWithThumbnails);

        // Get total count for pagination info
        const totalVideos = recommendedVideos.length;
        const hasNextPage = skip + limit < totalVideos;

        console.log(`✅ Recommended content served: page ${page}, ${videosWithThumbnails.length} videos`);

        res.json({
            videos: videosWithThumbnails,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalVideos / limit),
                totalVideos,
                hasNextPage,
                limit
            }
        });

    } catch (error) {
        console.error('💥 Error fetching recommended content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export const getRecommendations = async (req, res) => {
    try {
        const videoId = req.params.videoId;
        console.log('🎯 Fetching recommendations for video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const currentVideo = await Video.findById(videoId);
        if (!currentVideo) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const { findSimilarVideos } = await import('../../algorithms/videoSimilarity.js');
        const result = await findSimilarVideos(currentVideo, page, limit);

        console.log(`✅ Recommendations served: page ${page}, ${result.videos.length} videos`);

        res.json(result);

    } catch (error) {
        console.error('💥 Error fetching recommendations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export const getVideoStatus = async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        let estimatedTimeRemaining = null;
        if (video.status === 'processing' && video.processingStart) {
            const processingTimeSoFar = Date.now() - video.processingStart.getTime();
            estimatedTimeRemaining = Math.max(0, Math.round((video.duration * 1000 - processingTimeSoFar) / 1000));
        }

        res.json({
            status: video.status,
            progress: video.status === 'processing' ? 'Transcoding in progress' : null,
            estimatedTimeRemaining,
            processingStart: video.processingStart,
            processingEnd: video.processingEnd
        });
    } catch (error) {
        console.error('Error getting video status:', error);
        res.status(500).json({ error: 'Failed to retrieve video status' });
    }
};

export const uploadInit = async (req, res) => {
    try {
        const {
            fileName,
            fileType,
            title,
            description,
            tags,
            category,
            visibility,
            isAgeRestricted,
            commentsEnabled,
            selectedRoles
        } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `uploads/video/${userId}/${fileId}_${fileName}`;

        const video = await Video.create({
            _id: fileId,
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
            userId,
        });

        console.log(`📤 Video upload initialized: ${fileId}, title: "${title || fileName}"`);

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ uploadUrl, fileId });
    } catch (error) {
        console.error("Error generating presigned URL:", error);
        res.status(500).json({ error: "Failed to generate upload URL" });
    }
};

export const getUserPreferences = async (req, res) => {
    try {

        let raw = req.user;

        // If middleware assigned something like req.user = { id: '...' } keep that flow
        if (raw && typeof raw === "object") {
            // try common fields
            raw = raw.id ?? raw._id ?? raw.userId ?? raw;
        }

        // If it's still not a string, stringify for regex / parsing attempts
        let userId = null;
        if (typeof raw === "string") {
            // 1) If string is a clean ObjectId (24 hex chars)
            const simpleMatch = raw.match(/^[a-fA-F0-9]{24}$/);
            if (simpleMatch) {
                userId = simpleMatch[0];
            } else {
                // 2) Try JSON.parse (handles valid JSON like '{"id":"..."}')
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && (parsed.id || parsed._id || parsed.userId)) {
                        userId = parsed.id ?? parsed._id ?? parsed.userId;
                    }
                } catch (e) {
                    // ignore parse error - continue to regex fallback
                }

                // 3) Regex fallback: find any 24-hex substring inside the string
                if (!userId) {
                    const regex = /[a-fA-F0-9]{24}/;
                    const m = raw.match(regex);
                    if (m) userId = m[0];
                }
            }
        } else if (typeof raw === "number") {
            // unlikely, but handle numeric id scenario
            userId = String(raw);
        }

        // If still not found, return default
        if (!userId) {
            console.warn("getUserPreferences: could not extract userId from req.user:", req.user);
            return res.json({ preferredRendition: "Auto" });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            console.warn("getUserPreferences: invalid ObjectId extracted:", userId);
            return res.status(400).json({ error: "Invalid user id" });
        }

        // Query User model for preferences
        const user = await User.findById(userId).select(
            "preferredQuality autoQualityEnabled stableVolumeEnabled playbackSpeed"
        );

        if (!user) {
            console.warn("getUserPreferences: user not found:", userId);
            return res.status(404).json({ error: "User not found" });
        }

        return res.json({
            preferredQuality: user.preferredQuality || "auto",
            autoQualityEnabled: user.autoQualityEnabled !== false,
            stableVolumeEnabled: user.stableVolumeEnabled !== false,
            playbackSpeed: user.playbackSpeed || 1.0
        });
    } catch (err) {
        console.error("Error in getUserPreferences:", err);
        return res.status(500).json({ error: "Failed to get user preferences" });
    }
};

export const updateUserPreferences = async (req, res) => {
    try {
        let raw = req.user;

        // extract userId robustly (same approach as getUserPreferences)
        if (raw && typeof raw === "object") {
            raw = raw.id ?? raw._id ?? raw.userId ?? raw;
        }

        let userId = null;
        if (typeof raw === "string") {
            const simpleMatch = raw.match(/^[a-fA-F0-9]{24}$/);
            if (simpleMatch) {
                userId = simpleMatch[0];
            } else {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && (parsed.id || parsed._id || parsed.userId)) {
                        userId = parsed.id ?? parsed._id ?? parsed.userId;
                    }
                } catch (e) {
                    // ignore
                }
                if (!userId) {
                    const regex = /[a-fA-F0-9]{24}/;
                    const m = raw.match(regex);
                    if (m) userId = m[0];
                }
            }
        } else if (typeof raw === "number") {
            userId = String(raw);
        }

        if (!userId) {
            console.warn("updateUserPreferences: could not extract userId from req.user:", req.user);
            return res.status(400).json({ error: "User id not available" });
        }

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: "Invalid user id" });
        }

        const allowedKeys = [
            "preferredQuality",
            "autoQualityEnabled",
            "stableVolumeEnabled",
            "playbackSpeed"
        ];

        const incoming = req.body || {};
        const safePrefs = {};
        for (const k of allowedKeys) {
            if (Object.prototype.hasOwnProperty.call(incoming, k)) {
                safePrefs[k] = incoming[k];
            }
        }

        if (Object.keys(safePrefs).length === 0) {
            return res.status(400).json({ error: "No valid preference keys provided" });
        }

        // Validate preferredQuality enum
        if (safePrefs.preferredQuality && !["auto", "144p", "360p", "480p", "720p", "1080p", "1440p", "2160p"].includes(safePrefs.preferredQuality)) {
            return res.status(400).json({ error: "Invalid preferred quality value" });
        }

        // Validate playbackSpeed range
        if (typeof safePrefs.playbackSpeed === 'number' && (safePrefs.playbackSpeed < 0.25 || safePrefs.playbackSpeed > 4.0)) {
            return res.status(400).json({ error: "Playback speed must be between 0.25 and 4.0" });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Update user preferences directly on the user model
        Object.assign(user, safePrefs);
        await user.save();

        return res.json({
            preferredQuality: user.preferredQuality,
            autoQualityEnabled: user.autoQualityEnabled,
            stableVolumeEnabled: user.stableVolumeEnabled,
            playbackSpeed: user.playbackSpeed
        });
    } catch (err) {
        console.error("Error in updateUserPreferences:", err);
        return res.status(500).json({ error: "Failed to update user preferences" });
    }
};

export const uploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize } = req.body;

        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: 'Invalid file ID' });
        }

        await Video.findByIdAndUpdate(fileId, {
            status: 'processing',
            'sizes.original': fileSize,
            processingStart: new Date()
        });
        res.json({ success: true, message: 'Queue reset and video added' });
    } catch (error) {
        console.error('Error completing upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};

export const recordView = async (req, res) => {
    try {
        const { id: videoId } = req.params;
        const userId = req.user?.id;
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.get('User-Agent');

        if (!videoId) {
            return res.status(400).json({ error: "Video ID required" });
        }

        console.log(`📊 Recording view for video: ${videoId} by user: ${userId}`);

        // Fetch updated video to return new view count
        const updatedVideo = await updateViews(videoId, userId, ipAddress, userAgent);

        if (!updatedVideo) {
            return res.status(404).json({ error: "Video not found" });
        }

        return res.status(200).json({
            success: true,
            message: "View recorded successfully",
            views: updatedVideo.viewCount || 0,
            video: {
                _id: updatedVideo._id,
                title: updatedVideo.title,
                views: updatedVideo.views || 0
            }
        });
    } catch (error) {
        console.error("❌ Error recording view:", error);
        return res.status(500).json({
            error: "Failed to record view",
            message: error.message
        });
    }
};
export const getGeneralContent = async (req, res) => {
    try {
        console.log("🔍 Fetching latest 100 videos");

        const videos = await Video.find()
            .sort({ createdAt: -1 }) // newest first
            .limit(100) // max 100 videos
            .select('title description duration status thumbnailKey renditions createdAt tags');

        console.log("✅ Videos found:", videos.length);

        const videosWithUrls = await Promise.all(
            videos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: video.thumbnailKey,
                            }),
                            { expiresIn: 3600 }
                        );
                    } catch (s3Error) {
                        console.error('❌ Thumbnail error for video:', video._id);
                        thumbnailUrl = null;
                    }
                }

                return {
                    _id: video._id,
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    status: video.status,
                    thumbnailUrl,
                    tags: video.tags,
                    createdAt: video.createdAt,
                    renditions: video.renditions || [],
                    adaptiveStreaming: video.status === 'completed'
                };
            })
        );

        res.json(videosWithUrls);
    } catch (error) {
        console.error('💥 Error fetching videos:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Upload custom thumbnail for video
 * Sets thumbnailSource to 'custom' so worker won't overwrite it
 */
export const uploadVideoThumbnail = async (req, res) => {
    try {
        const { id: videoId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Check if file was uploaded (via multer or similar)
        if (!req.file && !req.files?.thumbnail) {
            return res.status(400).json({ error: 'No thumbnail file provided' });
        }

        const file = req.file || req.files.thumbnail[0];
        const thumbnailKey = `thumbnails/videos/${userId}/${videoId}_custom.${file.mimetype.split('/')[1] || 'jpg'}`;

        // Upload to S3
        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: thumbnailKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3Client.send(command);

        // Update video with thumbnail key and mark as custom
        await Video.findByIdAndUpdate(videoId, {
            thumbnailKey,
            thumbnailSource: 'custom'
        });

        console.log(`✅ Custom thumbnail uploaded for video: ${videoId}`);

        res.json({
            success: true,
            message: 'Thumbnail uploaded successfully',
            thumbnailKey
        });
    } catch (error) {
        console.error('❌ Error uploading video thumbnail:', error);
        res.status(500).json({ error: 'Failed to upload thumbnail' });
    }
};
