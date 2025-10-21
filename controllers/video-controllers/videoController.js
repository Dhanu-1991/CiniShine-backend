// controllers/video-controllers/videoController.js
import Video from "../../models/video.model.js";
import mongoose from 'mongoose';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Redis from 'ioredis';

const redisClient = new Redis(process.env.REDIS_URL, {
    retryStrategy: times => Math.min(times * 50, 2000)
});

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
        const prefix = `hls/${userId}/${videoId}/`;
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

// Get HLS master playlist URL
export const getVideo = async (req, res) => {
    try {
        const videoId = req.params.id ?? req.params.videoId;
        console.log('Fetching video with ID:', videoId);

        const video = await Video.findById(videoId).populate('userId', 'userName');
        if (!video) {
            console.error('Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        // Generate signed URL for master playlist
        const masterPlaylistUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.hlsMasterKey,
            }),
            { expiresIn: 3600 }
        );

        // Generate signed URL for thumbnail
        const thumbnailUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.thumbnailKey,
            }),
            { expiresIn: 3600 }
        );

        // Prepare renditions data
        const renditions = video.renditions.map(rendition => ({
            _id: rendition._id,
            name: rendition.name,
            resolution: rendition.resolution,
            bitrate: rendition.bitrate,
            codecs: rendition.codecs
        }));

        res.json({
            _id: video._id,
            title: video.title,
            description: video.description,
            duration: video.duration,
            hlsMasterUrl: masterPlaylistUrl,
            thumbnailUrl,
            renditions,
            status: video.status,
            createdAt: video.createdAt,
            user: video.userId
        });

    } catch (error) {
        console.error('Error fetching video data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export const getHLSMasterPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        console.log('🎬 Serving master playlist for video:', videoId);

        // Validate video ID
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            console.error('❌ Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check if video is ready for streaming
        if (video.status !== 'completed') {
            return res.status(423).json({
                error: 'Video is still processing',
                status: video.status
            });
        }

        // Check user access
        const userId = req.user.id;
        if (video.userId.toString() !== userId && video.visibility === 'private') {
            return res.status(403).json({ error: 'Access denied to this video' });
        }

        // FIX: Handle missing hlsMasterKey gracefully
        if (!video.hlsMasterKey) {
            console.error('❌ No HLS master key found for video:', videoId);

            // Try to find the master playlist in S3
            const hlsFiles = await findHLSFiles(videoId, video.userId);
            const masterFile = hlsFiles.find(file => file.Key.includes('master.m3u8'));

            if (!masterFile) {
                return res.status(404).json({ error: 'Master playlist not found' });
            }

            video.hlsMasterKey = masterFile.Key;
            await video.save();
        }

        console.log('📡 Generating signed URL for master playlist:', video.hlsMasterKey);

        // Generate signed URL for master playlist from S3
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.hlsMasterKey,
            }),
            { expiresIn: 3600 }
        );

        console.log('🔗 Signed URL generated, fetching master playlist...');

        // Fetch the master playlist content from S3
        const response = await fetch(signedUrl);
        if (!response.ok) {
            throw new Error(`S3 responded with status: ${response.status}`);
        }

        let masterContent = await response.text();
        console.log('📄 Master playlist fetched, size:', masterContent.length, 'bytes');

        // FIX: More robust URL replacement
        masterContent = masterContent.replace(
            /(\b[\w\-]+\.m3u8\b)/g,
            (match, variantFile) => {
                // Ensure we're only replacing actual variant filenames, not comments
                if (match.startsWith('#')) return match;

                const backendUrl = `/api/v2/video/${videoId}/variants/${variantFile}`;
                console.log(`🔄 Replacing variant: ${variantFile} → ${backendUrl}`);
                return backendUrl;
            }
        );

        // Set proper headers for HLS
        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Master playlist served successfully for video:', videoId);
        res.send(masterContent);

    } catch (error) {
        console.error('💥 Error serving master playlist:', error);

        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: 'Master playlist not found in storage' });
        }

        if (error.name === 'NetworkError' || error.code === 'ENOTFOUND') {
            return res.status(502).json({ error: 'Storage service unavailable' });
        }

        res.status(500).json({
            error: 'Failed to load video stream',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const getHLSVariantPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        const variantFile = req.params.variantFile;

        console.log('🎬 Serving variant playlist:', variantFile, 'for video:', videoId);

        // Validate inputs
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        if (!variantFile || !variantFile.endsWith('.m3u8')) {
            return res.status(400).json({ error: 'Invalid variant file name' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check video status
        if (video.status !== 'completed') {
            return res.status(423).json({ error: 'Video is still processing' });
        }

        // Check user access
        const userId = req.user.id;
        if (video.userId.toString() !== userId && video.visibility === 'private') {
            return res.status(403).json({ error: 'Access denied to this video' });
        }

        // FIX: Use the actual hlsMasterKey to determine the folder structure
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/${video.userId}/${videoId}/`;

        const variantKey = `${basePath}${variantFile}`;
        console.log('📡 Variant S3 key:', variantKey);

        // Generate signed URL for variant playlist
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: variantKey,
            }),
            { expiresIn: 3600 }
        );

        console.log('🔗 Signed URL generated for variant, fetching content...');

        const response = await fetch(signedUrl);
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`Variant playlist not found: ${variantKey}`);
            }
            throw new Error(`S3 responded with status: ${response.status}`);
        }

        let variantContent = await response.text();
        console.log('📄 Variant playlist fetched, size:', variantContent.length, 'bytes');

        // FIX: More robust segment URL replacement
        variantContent = variantContent.replace(
            /(\b[\w\-]+\.ts\b)/g,
            (match, segmentFile) => {
                if (match.startsWith('#')) return match;

                const backendUrl = `/api/v2/video/${videoId}/segments/${segmentFile}`;
                console.log(`🔄 Replacing segment: ${segmentFile} → ${backendUrl}`);
                return backendUrl;
            }
        );

        // Set proper headers
        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Variant playlist served successfully:', variantFile);
        res.send(variantContent);

    } catch (error) {
        console.error('💥 Error serving variant playlist:', error);

        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: 'Variant playlist not found in storage' });
        }

        if (error.message.includes('not found')) {
            return res.status(404).json({ error: 'Variant playlist not found' });
        }

        if (error.name === 'NetworkError' || error.code === 'ENOTFOUND') {
            return res.status(502).json({ error: 'Storage service unavailable' });
        }

        res.status(500).json({
            error: 'Failed to load video variant',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const getHLSSegment = async (req, res) => {
    try {
        const videoId = req.params.id;
        const segmentFile = req.params.segmentFile;

        console.log('🎬 Serving segment:', segmentFile, 'for video:', videoId);

        // Validate inputs
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        if (!segmentFile || !segmentFile.endsWith('.ts')) {
            return res.status(400).json({ error: 'Invalid segment file name' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check video status
        if (video.status !== 'completed') {
            return res.status(423).json({ error: 'Video is still processing' });
        }

        // Check user access
        const userId = req.user.id;
        if (video.userId.toString() !== userId && video.visibility === 'private') {
            return res.status(403).json({ error: 'Access denied to this video' });
        }

        // FIX: Use the actual hlsMasterKey to determine the folder structure
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/${video.userId}/${videoId}/`;

        const segmentKey = `${basePath}${segmentFile}`;
        console.log('📡 Segment S3 key:', segmentKey);

        // Generate signed URL for segment
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: segmentKey,
            }),
            { expiresIn: 7200 }
        );

        console.log('🔗 Redirecting to signed segment URL:', signedUrl.substring(0, 100) + '...');

        // FIX: Use proxy instead of redirect for better HLS.js compatibility
        // For now, keep redirect but consider switching to proxy if issues persist
        res.redirect(307, signedUrl);

    } catch (error) {
        console.error('💥 Error serving segment:', error);

        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: 'Video segment not found in storage' });
        }

        if (error.name === 'NetworkError' || error.code === 'ENOTFOUND') {
            return res.status(502).json({ error: 'Storage service unavailable' });
        }

        res.status(500).json({
            error: 'Failed to load video segment',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
export const getMyContent = async (req, res) => {
    try {
        const userId = req.user; // Assuming you have auth middleware

        console.log("🔍 Fetching videos for user ID:", userId);
        console.log("User ID type:", typeof userId);

        // Convert userId to ObjectId for proper querying
        let userObjectId;
        if (mongoose.Types.ObjectId.isValid(userId)) {
            userObjectId = new mongoose.Types.ObjectId(userId);
            console.log("Converted to ObjectId:", userObjectId);
        } else {
            userObjectId = userId;
            console.log("Using raw userId (not ObjectId)");
        }

        const videos = await Video.find({ userId: userObjectId })
            .sort({ createdAt: -1 })
            .select('title description duration status thumbnailKey renditions createdAt tags');

        console.log("✅ Number of videos found:", videos.length);

        if (videos.length === 0) {
            console.log("❌ No videos found for user:", userId);
            // Let's debug why no videos are found
            const allVideos = await Video.find({}).select('userId title').limit(5);
            console.log("Sample videos in DB:", allVideos);
            return res.json([]);
        }

        console.log("📹 Videos found:", videos.map(v => ({
            id: v._id,
            title: v.title,
            userId: v.userId,
            status: v.status
        })));

        // Generate signed URLs for thumbnails
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
                        console.log(`✅ Generated thumbnail URL for video: ${video._id}`);
                    } catch (s3Error) {
                        console.error('❌ Error generating thumbnail URL for video:', video._id, s3Error);
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

        console.log("🎯 Final response with", videosWithUrls.length, "videos");
        res.json(videosWithUrls);
    } catch (error) {
        console.error('💥 Error fetching user videos:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Get video status
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

// Initialize upload - get presigned URL
export const uploadInit = async (req, res) => {
    try {
        const { fileName, fileType } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `uploads/${userId}/${fileId}_${fileName}`;

        const video = await Video.create({
            _id: fileId,
            title: fileName,
            originalKey: key,
            userId,
        });

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });
        console.log("Generating presigned URL for:", key);
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        console.log("Generated presigned URL:", uploadUrl);

        res.json({ uploadUrl, fileId });
    } catch (error) {
        console.error("Error generating presigned URL:", error);
        res.status(500).json({ error: "Failed to generate upload URL" });
    }
};

// Complete upload - trigger processing
export const uploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize } = req.body;

        // Validate fileId
        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: 'Invalid file ID' });
        }

        // Update video status and add to processing queue
        await Video.findByIdAndUpdate(fileId, {
            status: 'processing',
            'sizes.original': fileSize,
            processingStart: new Date()
        });

        // Add to processing queue
        await redisClient.lpush('video-processing-queue', fileId.toString());
        console.log(`Video ${fileId} added to processing queue`);

        res.json({ success: true, message: 'Video queued for processing' });
    } catch (error) {
        console.error('Error completing upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};
