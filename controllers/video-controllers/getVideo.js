import Video from "../../models/video.model.js";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import pkg from "@aws-sdk/s3-request-presigner";
const { getSignedUrl } = pkg;
import 'dotenv/config';
import mongoose from 'mongoose';

const s3Client = new S3Client({
    region: process.env.AWS_REGION, // e.g., 'us-east-1'
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});



// Helper to get signed thumbnail URL
async function getSignedUrlForThumbnail(thumbnailKey) {
    if (!thumbnailKey) return null;
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: thumbnailKey,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

// Get HLS master playlist URL with signed URL
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

        // Generate signed URL for the master playlist
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

// Get video status with processing time estimation
export const getVideoStatus = async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        let estimatedTimeRemaining = null;
        if (video.status === 'processing' && video.processingStart) {
            // Simple estimation: assume 1 minute per minute of video
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
        console.log("🔔 uploadInit called with body:", req.body);
        const { fileName, fileType } = req.body;

        // Use authenticated user ID instead of client-provided string
        const userId = req.user?.id;
        console.log("🔔 Authenticated user ID:", userId);

        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        const fileId = new mongoose.Types.ObjectId();
        console.log("🔔 Generated fileId:", fileId);
        const key = `uploads/${userId}/${fileId}_${fileName}`;
        console.log("🔔 Generated S3 key:", key);

        
        const video = await Video.create({
            _id: fileId,
            title: fileName,
            originalKey: key,
            userId, // ✅ valid ObjectId
        });
        console.log("🔔 Video document created:", video);

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });
        console.log("putObjectCommand created:", command);

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        console.log("🔔 Generated upload URL:", uploadUrl);
        res.json({ uploadUrl, fileId });
    } catch (error) {
        console.error("Error generating presigned URL:", error);
        res.status(500).json({ error: "Failed to generate upload URL" });
    }
};


export const uploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize } = req.body;

        await Video.findByIdAndUpdate(fileId, {
            status: 'processing',
            'sizes.original': fileSize,
        });

        // Add to processing queue
        await redisClient.lPush('video-processing-queue', fileId.toString());

        res.json({ success: true, message: 'Video queued for processing' });
    } catch (error) {
        console.error('Error completing upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};
