/**
 * Migration Script: Convert existing likes/dislikes arrays to VideoReaction collection
 * 
 * Usage:
 * 1. Update this file with your MongoDB connection string
 * 2. Run: node migration.js
 * 3. Verify data was migrated correctly
 * 4. Remove old fields from Video schema if needed
 */

import mongoose from "mongoose";
import Video from "./models/video.model.js";
import VideoReaction from "./models/videoReaction.model.js";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/mydb";

async function migrateReactions() {
    try {
        console.log("🔗 Connecting to MongoDB...");
        await mongoose.connect(MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        console.log("\n📊 Starting migration...");

        const videos = await Video.find({
            $or: [
                { likes: { $exists: true, $ne: [] } },
                { dislikes: { $exists: true, $ne: [] } }
            ]
        });

        console.log(`📹 Found ${videos.length} videos with likes/dislikes to migrate`);

        let totalMigrated = 0;
        let totalSkipped = 0;

        for (const video of videos) {
            console.log(`\n📹 Processing video: ${video._id}`);

            // Migrate likes
            if (video.likes && video.likes.length > 0) {
                console.log(`  ❤️ Migrating ${video.likes.length} likes...`);
                try {
                    const likeReactions = video.likes.map(userId => ({
                        videoId: video._id,
                        userId: userId,
                        type: 'like',
                        createdAt: video.createdAt || new Date()
                    }));

                    // insertMany with ordered: false to skip duplicates
                    await VideoReaction.insertMany(likeReactions, { ordered: false });
                    video.likeCount = video.likes.length;
                    console.log(`  ✅ ${video.likes.length} likes migrated`);
                    totalMigrated += video.likes.length;
                } catch (error) {
                    if (error.code === 11000) {
                        // Duplicate key error - some were already migrated
                        const duplicateCount = error.writeErrors?.length || 0;
                        const inserted = video.likes.length - duplicateCount;
                        console.log(`  ⚠️ ${inserted}/${video.likes.length} likes inserted (${duplicateCount} duplicates skipped)`);
                        video.likeCount = Math.max(video.likeCount || 0, video.likes.length);
                        totalMigrated += inserted;
                        totalSkipped += duplicateCount;
                    } else {
                        console.error(`  ❌ Error migrating likes:`, error.message);
                        totalSkipped += video.likes.length;
                    }
                }
            }

            // Migrate dislikes
            if (video.dislikes && video.dislikes.length > 0) {
                console.log(`  👎 Migrating ${video.dislikes.length} dislikes...`);
                try {
                    const dislikeReactions = video.dislikes.map(userId => ({
                        videoId: video._id,
                        userId: userId,
                        type: 'dislike',
                        createdAt: video.createdAt || new Date()
                    }));

                    await VideoReaction.insertMany(dislikeReactions, { ordered: false });
                    video.dislikeCount = video.dislikes.length;
                    console.log(`  ✅ ${video.dislikes.length} dislikes migrated`);
                    totalMigrated += video.dislikes.length;
                } catch (error) {
                    if (error.code === 11000) {
                        const duplicateCount = error.writeErrors?.length || 0;
                        const inserted = video.dislikes.length - duplicateCount;
                        console.log(`  ⚠️ ${inserted}/${video.dislikes.length} dislikes inserted (${duplicateCount} duplicates skipped)`);
                        video.dislikeCount = Math.max(video.dislikeCount || 0, video.dislikes.length);
                        totalMigrated += inserted;
                        totalSkipped += duplicateCount;
                    } else {
                        console.error(`  ❌ Error migrating dislikes:`, error.message);
                        totalSkipped += video.dislikes.length;
                    }
                }
            }

            // Update video document
            await video.save();
        }

        console.log("\n✅ Migration Summary:");
        console.log(`  📊 Total reactions migrated: ${totalMigrated}`);
        console.log(`  ⚠️ Total duplicates skipped: ${totalSkipped}`);
        console.log(`  📹 Videos updated: ${videos.length}`);

        console.log("\n📝 Creating indexes...");
        try {
            await VideoReaction.collection.createIndex(
                { videoId: 1, userId: 1 },
                { unique: true }
            );
            console.log("  ✅ Compound index created");

            await VideoReaction.collection.createIndex({ videoId: 1 });
            console.log("  ✅ videoId index created");

            await VideoReaction.collection.createIndex({ userId: 1 });
            console.log("  ✅ userId index created");
        } catch (indexError) {
            console.warn("  ⚠️ Index creation warning:", indexError.message);
        }

        console.log("\n✅ Migration completed successfully!");
        console.log("\n📋 Next steps:");
        console.log("  1. Verify data migration by checking VideoReaction collection");
        console.log("  2. Test like/dislike functionality in your app");
        console.log("  3. Optional: Remove old 'likes' and 'dislikes' arrays from Video schema");
        console.log("     (They'll be ignored but keeping them uses extra storage)");

    } catch (error) {
        console.error("\n❌ Migration failed:", error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log("\n🔌 MongoDB connection closed");
    }
}

// Run migration
migrateReactions();
