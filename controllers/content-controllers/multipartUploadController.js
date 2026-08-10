/**
 * Multipart Upload Controller
 * Handles S3 multipart uploads for fast, parallel chunk uploading
 * Supports files up to 5GB with concurrent part uploads
 */

import {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mongoose from "mongoose";
import Content from "../../models/content.model.js"; 
import User from '../../models/user.model.js';
import ContentToCommunity from '../../models/contentToCommunity.model.js';
import Community from '../../models/community.model.js';
import CommunityMember from '../../models/communityMember.model.js'; import { createUploadNotifications } from "../notification-controllers/notificationController.js";

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const BUCKET = process.env.S3_BUCKET;

// Chunk size: 10MB (minimum for S3 multipart is 5MB, except last part)
const MIN_PART_SIZE = 10 * 1024 * 1024; // 10MB
const TITLE_MAX_WORDS = 50;
const DESCRIPTION_MAX_WORDS = 300;

const countWords = (text = "") =>
    text
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

const validateTitleDescription = (title, description) => {
    if (!title || !title.trim()) {
        return "Title is required";
    }

    if (!description || !description.trim()) {
        return "Description is required";
    }

    if (countWords(title) > TITLE_MAX_WORDS) {
        return `Title can be at most ${TITLE_MAX_WORDS} words`;
    }

    if (countWords(description) > DESCRIPTION_MAX_WORDS) {
        return `Description can be at most ${DESCRIPTION_MAX_WORDS} words`;
    }

    return null;
};

/**
 * Step 1: Initialize multipart upload
 * Creates a Content document and starts S3 multipart upload
 * Returns uploadId, fileId, and presigned URLs for all parts
 */
export const multipartInit = async (req, res) => {
    try {
        const {
            fileName,
            fileType,
            fileSize,
            contentType: cType,
            title,
            description,
            tags,
            category,
            visibility,
            price,
            trailerContentId,
            spoilerText,
            isAgeRestricted,
            commentsEnabled,
            selectedRoles,
        } = req.body;

        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        // Check if creator's channel is banned
        const uploadUser = await User.findById(userId).select('channelBanned').lean();
        if (uploadUser?.channelBanned) {
            return res.status(403).json({ error: 'Your channel has been banned. You cannot upload new content.' });
        }

        if (!fileName || !fileType || !fileSize) {
            return res.status(400).json({ error: "fileName, fileType, and fileSize are required" });
        }

        const metadataError = validateTitleDescription(title, description);
        if (metadataError) {
            return res.status(400).json({ error: metadataError });
        }

        // Validate file size (max 20GB)
        const maxSize = 20 * 1024 * 1024 * 1024; // 20GB
        if (fileSize > maxSize) {
            return res.status(400).json({ error: "File size exceeds 20GB limit" });
        }

        // Validate PPV price
        if (visibility === 'pay_per_view') {
            const numPrice = Number(price);
            if (!numPrice || numPrice < 1) {
                return res.status(400).json({ error: "Price is required and must be at least ₹1 for Pay Per View content" });
            }
        }

        // Validate trailer: only public watchinit videos are allowed
        let parsedTrailerId = null;
        if (visibility === 'pay_per_view' && trailerContentId) {
            const match = trailerContentId.match(/([a-f\d]{24})$/i);
            parsedTrailerId = match ? match[1] : null;
            if (parsedTrailerId) {
                const trailerContent = await Content.findById(parsedTrailerId).select('visibility');
                if (!trailerContent) {
                    return res.status(400).json({ error: 'Trailer content not found. Make sure the video exists on WatchinIt.' });
                }
                if (trailerContent.visibility !== 'public') {
                    return res.status(400).json({ error: 'Trailer video must be set to Public visibility. Private, unlisted, or PPV videos cannot be used as trailers.' });
                }
            }
        }

        const contentType = cType || "video";
        const fileId = new mongoose.Types.ObjectId();

        // Determine S3 key based on content type
        let keyPrefix = "uploads";
        if (contentType === "short") keyPrefix = "shorts";
        else if (contentType === "audio") keyPrefix = "audio";

        const key = `${keyPrefix}/${userId}/${fileId}_${fileName}`;

        // Create content document in DB
        await Content.create({
            _id: fileId,
            contentType,
            title: title.trim(),
            description: description.trim(),
            tags: tags ? (Array.isArray(tags) ? tags : tags.split(",").map((t) => t.trim())) : [],
            category: category || "",
            visibility: visibility || "public",
            price: visibility === 'pay_per_view' ? Number(price) : null,
            trailerContentId: parsedTrailerId,
            spoilerText: visibility === 'pay_per_view' ? spoilerText : null,
            isAgeRestricted: isAgeRestricted || false,
            commentsEnabled: commentsEnabled !== false,
            selectedRoles: selectedRoles || [],
            originalKey: key,
            fileSize: fileSize,
            mimeType: fileType,
            userId,
            status: "uploading",
        });

        // Initiate S3 multipart upload
        const createCommand = new CreateMultipartUploadCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const multipartUpload = await s3Client.send(createCommand);
        const uploadId = multipartUpload.UploadId;

        // Calculate optimal part size (dynamic for up to 20GB)
        let targetPartSize = MIN_PART_SIZE; // 10MB base
        if (fileSize > 5 * 1024 * 1024 * 1024) {
            targetPartSize = 32 * 1024 * 1024; // 32MB chunks for > 5GB
        } else if (fileSize > 1 * 1024 * 1024 * 1024) {
            targetPartSize = 20 * 1024 * 1024; // 20MB chunks for > 1GB
        }
        const partSize = Math.max(targetPartSize, Math.ceil(fileSize / 1000));
        const numParts = Math.ceil(fileSize / partSize);

        // Generate presigned URLs for all parts in parallel (valid for 4 hours)
        const urlPromises = [];
        for (let partNumber = 1; partNumber <= numParts; partNumber++) {
            const uploadPartCommand = new UploadPartCommand({
                Bucket: BUCKET,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
            });
            urlPromises.push(
                getSignedUrl(s3Client, uploadPartCommand, { expiresIn: 14400 }).then((url) => ({
                    partNumber,
                    url,
                }))
            );
        }

        const presignedUrls = await Promise.all(urlPromises);

        const fileSizeGB = (fileSize / (1024 * 1024 * 1024)).toFixed(2);
        console.log(
            `📤 [TRACKING] Multipart upload initialized: ID=${fileId}, User=${userId}, Size=${fileSize} bytes (${fileSizeGB} GB), parts=${numParts}, partSize=${(partSize / 1024 / 1024).toFixed(1)}MB`
        );

        res.json({
            fileId: fileId.toString(),
            uploadId,
            key,
            partSize,
            numParts,
            presignedUrls, // Array of { partNumber, url }
        });
    } catch (error) {
        console.error("❌ Error initializing multipart upload:", error);
        res.status(500).json({ error: "Failed to initialize multipart upload" });
    }
};

/**
 * Step 2: Complete multipart upload
 * Called after all parts are uploaded successfully
 */
export const multipartComplete = async (req, res) => {
    try {
        const { fileId, uploadId, key, parts, fileSize, contentType, title, description } = req.body;
        const userId = req.user?.id;

        if (!fileId || !uploadId || !key || !parts) {
            return res.status(400).json({ error: "fileId, uploadId, key, and parts are required" });
        }

        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: "Invalid file ID" });
        }

        const existingContent = await Content.findById(fileId).select("title description userId fileSize createdAt");
        if (!existingContent) {
            return res.status(404).json({ error: "Content not found" });
        }

        if (!userId || existingContent.userId?.toString() !== userId) {
            return res.status(403).json({ error: "Not authorized" });
        }

        // Complete multipart upload on S3
        // Parts must be sorted by PartNumber
        const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: BUCKET,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: sortedParts,
            },
        });

        await s3Client.send(completeCommand);

        // Determine status based on content type
        const isVideo = contentType === "video";
        const status = isVideo ? "processing" : "completed";
        const now = new Date();
        const uploadDurationSeconds = Math.max(1, Math.round((now - new Date(existingContent.createdAt)) / 1000));
        const totalSize = fileSize || existingContent.fileSize || 0;
        const totalGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
        const avgSpeedMBps = totalSize > 0 ? (totalSize / (1024 * 1024) / uploadDurationSeconds).toFixed(2) : "0.00";

        // Update content document
        const updateData = {
            status,
            fileSize: totalSize,
            "sizes.original": totalSize,
            processingStart: now,
        };

        if (title !== undefined || description !== undefined) {
            const nextTitle = title !== undefined ? title : existingContent.title;
            const nextDescription = description !== undefined ? description : existingContent.description;
            const metadataError = validateTitleDescription(nextTitle, nextDescription);
            if (metadataError) {
                return res.status(400).json({ error: metadataError });
            }
        }

        if (title !== undefined) updateData.title = title.trim();
        if (description !== undefined) updateData.description = description.trim();

        if (!isVideo) {
            updateData.publishedAt = new Date();
        }

        const content = await Content.findByIdAndUpdate(fileId, updateData, { new: true });

        // Notify subscribers about the new upload
        if (content) {
            createUploadNotifications(
                content.userId,
                content._id,
                contentType || "video",
                content.title,
                content.thumbnailKey
            ).catch((err) => console.error("Notification error:", err));
        }
        // Link content to communities if requested
        const postToCommunities = req.body.postToCommunities;
        if (postToCommunities && Array.isArray(postToCommunities) && postToCommunities.length > 0 && content) {
            try {
                const links = postToCommunities.map(cId => ({
                    contentId: content._id,
                    communityId: cId,
                    isImported: false,
                    createdAt: new Date()
                }));
                await ContentToCommunity.insertMany(links, { ordered: false }).catch(() => { });
                await Community.updateMany(
                    { _id: { $in: postToCommunities } },
                    { $inc: { contentCount: 1 } }
                );
            } catch (communityErr) {
                console.error('Community linking error:', communityErr.message);
            }
        }
        console.log(`✅ [TRACKING] Multipart upload completed: ID=${fileId}, Parts=${sortedParts.length}, Size=${totalSize} bytes (${totalGB} GB), UploadDuration=${uploadDurationSeconds}s, AvgSpeed=${avgSpeedMBps} MB/s`);

        res.json({
            success: true,
            message: "Upload completed successfully",
            contentId: fileId,
        });
    } catch (error) {
        console.error("❌ Error completing multipart upload:", error);
        res.status(500).json({ error: "Failed to complete multipart upload" });
    }
};

/**
 * Abort multipart upload (cleanup on failure)
 */
export const multipartAbort = async (req, res) => {
    try {
        const { uploadId, key, fileId } = req.body;

        if (!uploadId || !key) {
            return res.status(400).json({ error: "uploadId and key are required" });
        }

        const abortCommand = new AbortMultipartUploadCommand({
            Bucket: BUCKET,
            Key: key,
            UploadId: uploadId,
        });

        await s3Client.send(abortCommand);

        // Clean up the content document if it exists
        if (fileId && mongoose.Types.ObjectId.isValid(fileId)) {
            await Content.findByIdAndDelete(fileId);
        }

        console.log(`🗑️ Multipart upload aborted: ${uploadId}`);
        res.json({ success: true, message: "Upload aborted" });
    } catch (error) {
        console.error("❌ Error aborting multipart upload:", error);
        res.status(500).json({ error: "Failed to abort upload" });
    }
};
