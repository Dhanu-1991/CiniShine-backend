// controllers/video-controllers/videoController.js
import Video from "../../models/video.model.js";
import mongoose from 'mongoose';
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
// import redis from "ioredis";

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

// const redisClient = redis.createClient({
//     url: process.env.REDIS_URL,
// });
redisClient.connect().catch(console.error);

// Helper to get signed thumbnail URL
async function getSignedUrlForThumbnail(thumbnailKey) {
    if (!thumbnailKey) return null;
    const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: thumbnailKey,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

// Get HLS master playlist URL
export const getVideo = async (req, res) => {
    try {
        const { videoId } = req.params;

        const video = await Video.findById(videoId).populate('userId', 'userName fullName');
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Generate signed URL for master playlist
        const masterPlaylistUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.hlsMasterKey,
            }),
            { expiresIn: 3600 } // 1 hour
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