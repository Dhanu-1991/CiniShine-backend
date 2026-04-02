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
import Content from "../../models/content.model.js"; import ContentToCommunity from '../../models/contentToCommunity.model.js';
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
const TITLE_MAX_WORDS = 15;
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
            isAgeRestricted,
            commentsEnabled,
            selectedRoles,
        } = req.body;

        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        if (!fileName || !fileType || !fileSize) {
            return res.status(400).json({ error: "fileName, fileType, and fileSize are required" });
        }

        const metadataError = validateTitleDescription(title, description);
        if (metadataError) {
            return res.status(400).json({ error: metadataError });
        }

        // Validate file size (max 5GB)
        const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
        if (fileSize > maxSize) {
            return res.status(400).json({ error: "File size exceeds 5GB limit" });
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
            isAgeRestricted: isAgeRestricted || false,
            commentsEnabled: commentsEnabled !== false,
            selectedRoles: selectedRoles || [],
            originalKey: key,
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

        // Calculate number of parts
        const partSize = Math.max(MIN_PART_SIZE, Math.ceil(fileSize / 100)); // At least 10MB, max 100 parts
        const numParts = Math.ceil(fileSize / partSize);

        // Generate presigned URLs for all parts in parallel
        const urlPromises = [];
        for (let partNumber = 1; partNumber <= numParts; partNumber++) {
            const uploadPartCommand = new UploadPartCommand({
                Bucket: BUCKET,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
            });
            urlPromises.push(
                getSignedUrl(s3Client, uploadPartCommand, { expiresIn: 7200 }).then((url) => ({
                    partNumber,
                    url,
                }))
            );
        }

        const presignedUrls = await Promise.all(urlPromises);

        console.log(
            `📤 Multipart upload initialized: ${fileId}, parts: ${numParts}, partSize: ${(partSize / 1024 / 1024).toFixed(1)}MB`
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

        const existingContent = await Content.findById(fileId).select("title description userId");
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

        // Update content document
        const updateData = {
            status,
            "sizes.original": fileSize,
            processingStart: new Date(),
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
        console.log(`✅ Multipart upload completed: ${fileId} (${sortedParts.length} parts)`);

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
