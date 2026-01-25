import User from "../../models/user.model.js";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import path from "path";

/* ======================================================
   S3 CLIENT
====================================================== */
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/* ======================================================
   S3 HELPERS
====================================================== */

// Upload file to S3
const uploadToS3 = async (fileBuffer, fileName, mimeType) => {
    const uploadParams = {
        Bucket: process.env.S3_BUCKET,
        Key: fileName,
        Body: fileBuffer,
        ContentType: mimeType,
    };

    try {
        const command = new PutObjectCommand(uploadParams);
        await s3Client.send(command);

        return `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
    } catch (error) {
        console.error("S3 upload error:", error);
        throw new Error("Failed to upload to S3");
    }
};

// Delete file from S3
const deleteFromS3 = async (fileUrl) => {
    try {
        if (!fileUrl) return;

        const urlParts = fileUrl.split("/");
        const key = urlParts.slice(3).join("/");

        const deleteParams = {
            Bucket: process.env.S3_BUCKET,
            Key: key,
        };

        const command = new DeleteObjectCommand(deleteParams);
        await s3Client.send(command);
        return true;
    } catch (error) {
        console.error("S3 delete error:", error);
        return false;
    }
};

// Optimize image
const optimizeImage = async (buffer) => {
    try {
        return await sharp(buffer)
            .resize(400, 400, {
                fit: "cover",
                position: "center",
            })
            .jpeg({ quality: 80 })
            .toBuffer();
    } catch (error) {
        console.error("Image optimization error:", error);
        return buffer;
    }
};

/* ======================================================
   UPDATE CHANNEL PICTURE
====================================================== */
export const updateChannelPicture = async (req, res) => {
    try {
        // Auth check
        if (!req.user?.id) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        // File check
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Please upload a channel picture",
            });
        }

        // Find user
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        // Validate file type
        const allowedMimeTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            "image/webp",
        ];

        if (!allowedMimeTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                success: false,
                message: "Invalid file type. Only images are allowed.",
            });
        }

        // Validate file size (5MB)
        const maxSize = 5 * 1024 * 1024;
        if (req.file.size > maxSize) {
            return res.status(400).json({
                success: false,
                message: "File size too large. Max 5MB allowed.",
            });
        }

        // Delete old channel picture if exists
        if (user.channelPicture && user.channelPicture.includes("amazonaws.com")) {
            await deleteFromS3(user.channelPicture);
        }

        // Generate S3 key
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const fileName = `channelPictures/${req.user.id}/${uuidv4()}${fileExtension}`;

        // Optimize image
        const optimizedBuffer = await optimizeImage(req.file.buffer);

        // Upload to S3
        const s3Url = await uploadToS3(
            optimizedBuffer,
            fileName,
            req.file.mimetype
        );

        // Save to DB
        user.channelPicture = s3Url;
        user.updatedAt = new Date();
        await user.save();

        return res.status(200).json({
            success: true,
            message: "Channel picture updated successfully",
            channelPicture: s3Url,
            user: {
                _id: user._id,
                username: user.username,
                channelPicture: user.channelPicture,
                channelName: user.channelName || user.username,
                updatedAt: user.updatedAt,
            },
        });
    } catch (error) {
        console.error("Channel picture update error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update channel picture",
        });
    }
};

/* ======================================================
   REMOVE CHANNEL PICTURE
====================================================== */
export const removeChannelPicture = async (req, res) => {
    try {
        if (!req.user?.id) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        if (user.channelPicture && user.channelPicture.includes("amazonaws.com")) {
            await deleteFromS3(user.channelPicture);
        }

        user.channelPicture = null;
        user.updatedAt = new Date();
        await user.save();

        return res.status(200).json({
            success: true,
            message: "Channel picture removed successfully",
        });
    } catch (error) {
        console.error("Remove channel picture error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to remove channel picture",
        });
    }
};

/* ======================================================
   GET CHANNEL PICTURE
====================================================== */
export const getChannelPicture = async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await User.findById(userId).select(
            "channelPicture username channelName"
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        return res.status(200).json({
            success: true,
            channelPicture: user.channelPicture,
            channelName: user.channelName || user.username,
        });
    } catch (error) {
        console.error("Get channel picture error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get channel picture",
        });
    }
};
