/**
 * Set View Count for Content
 *
 * Run:
 *   node scripts/setViewCount.js <contentId> <viewCount>
 *
 * Example:
 *   node scripts/setViewCount.js 6654abc123def456 10000
 *
 * Requires env:
 *   MONGO_URI
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

async function setViewCount() {
    const [contentId, viewCountStr] = process.argv.slice(2);

    if (!contentId || !viewCountStr) {
        console.error("Usage: node scripts/setViewCount.js <contentId> <viewCount>");
        process.exit(1);
    }

    const viewCount = parseInt(viewCountStr, 10);
    if (isNaN(viewCount) || viewCount < 0) {
        console.error("viewCount must be a non-negative integer");
        process.exit(1);
    }

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
        console.error("Invalid contentId format");
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const result = await mongoose.connection.db
            .collection("contents")
            .updateOne(
                { _id: new mongoose.Types.ObjectId(contentId) },
                { $set: { views: viewCount } }
            );

        if (result.matchedCount === 0) {
            console.error("Content not found with ID:", contentId);
        } else {
            console.log(`Views updated to ${viewCount} for content ${contentId}`);
        }
    } catch (error) {
        console.error("Error:", error.message);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

setViewCount();
