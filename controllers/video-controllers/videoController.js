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
        const video = await Video.findById(req.params.id);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.status !== 'completed') {
            return res.status(202).json({
                status: video.status,
                message: 'Video is still processing'
            });
        }

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: video.hlsMasterKey,
        });

        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        res.json({
            masterUrl: signedUrl,
            duration: video.duration,
            thumbnail: await getSignedUrlForThumbnail(video.thumbnailKey),
            renditions: video.renditions
        });
    } catch (error) {
        console.error('Error getting video:', error);
        res.status(500).json({ error: 'Failed to retrieve video' });
    }
};

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