/**
 * Migration Script: Transfer Video data to unified Content model
 * 
 * This script safely copies all documents from the 'videos' collection
 * to the 'contents' collection with contentType: 'video'.
 * It also updates Comment and VideoReaction references.
 * 
 * Usage: node scripts/migrateVideoToContent.js
 * 
 * IMPORTANT: 
 * - Back up your database before running
 * - Run this ONCE, it is idempotent (skips already-migrated docs)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function migrate() {
    try {
        console.log('🚀 Starting Video → Content migration...');

        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;
        const videosCollection = db.collection('videos');
        const contentsCollection = db.collection('contents');
        const commentsCollection = db.collection('comments');
        const videoreactionsCollection = db.collection('videoreactions');

        // 1. Count existing videos
        const totalVideos = await videosCollection.countDocuments();
        console.log(`📊 Found ${totalVideos} videos to migrate`);

        if (totalVideos === 0) {
            console.log('✅ No videos to migrate. Exiting.');
            await mongoose.disconnect();
            return;
        }

        // 2. Check how many already migrated (idempotent)
        const alreadyMigrated = await contentsCollection.countDocuments({ contentType: 'video' });
        console.log(`📊 Already migrated: ${alreadyMigrated} video documents in contents`);

        // 3. Get all video documents
        const videos = await videosCollection.find({}).toArray();
        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const video of videos) {
            try {
                // Check if already migrated (by _id)
                const existing = await contentsCollection.findOne({ _id: video._id });
                if (existing) {
                    skipped++;
                    continue;
                }

                // Transform Video document to Content format
                const contentDoc = {
                    _id: video._id,
                    contentType: 'video',
                    userId: video.userId,
                    title: video.title || '',
                    description: video.description || '',
                    tags: video.tags || [],
                    category: video.category || '',
                    visibility: video.visibility || 'public',
                    isAgeRestricted: video.isAgeRestricted || false,
                    commentsEnabled: video.commentsEnabled !== false,
                    selectedRoles: video.selectedRoles || [],

                    // Media files
                    originalKey: video.originalKey || null,
                    hlsMasterKey: video.hlsMasterKey || null,
                    thumbnailKey: video.thumbnailKey || null,
                    thumbnailSource: video.thumbnailSource || 'auto',

                    // Metadata
                    duration: video.duration || 0,
                    fileSize: video.fileSize || 0,
                    mimeType: video.mimeType || null,
                    sizes: video.sizes || {},

                    // Processing
                    status: video.status || 'uploading',
                    processingStart: video.processingStart || null,
                    processingEnd: video.processingEnd || null,
                    renditions: video.renditions || [],

                    // Engagement
                    views: video.views || 0,
                    likeCount: video.likeCount || 0,
                    dislikeCount: video.dislikeCount || 0,

                    // Video analytics
                    lastViewedAt: video.lastViewedAt || null,
                    averageWatchTime: video.averageWatchTime || 0,
                    watchCount: video.watchCount || 0,
                    totalWatchTime: video.totalWatchTime || 0,

                    // Timestamps
                    createdAt: video.createdAt || new Date(),
                    updatedAt: new Date()
                };

                await contentsCollection.insertOne(contentDoc);
                migrated++;

                if (migrated % 100 === 0) {
                    console.log(`  📦 Migrated ${migrated}/${totalVideos} videos...`);
                }
            } catch (err) {
                errors++;
                console.error(`  ❌ Error migrating video ${video._id}:`, err.message);
            }
        }

        console.log(`\n📊 Video migration results:`);
        console.log(`  ✅ Migrated: ${migrated}`);
        console.log(`  ⏭️  Skipped (already exists): ${skipped}`);
        console.log(`  ❌ Errors: ${errors}`);

        // 4. Update Comment references: onModel 'Video' → 'Content'
        console.log('\n🔄 Updating Comment references...');
        const commentResult = await commentsCollection.updateMany(
            { onModel: 'Video' },
            { $set: { onModel: 'Content' } }
        );
        console.log(`  ✅ Updated ${commentResult.modifiedCount} comments (onModel: Video → Content)`);

        // 5. Log VideoReaction info (these reference by videoId which is just an ObjectId, no model change needed)
        const reactionCount = await videoreactionsCollection.countDocuments();
        console.log(`\n📊 VideoReactions: ${reactionCount} documents (no model reference change needed)`);

        // 6. Verify migration
        const finalContentVideos = await contentsCollection.countDocuments({ contentType: 'video' });
        const finalContentTotal = await contentsCollection.countDocuments();
        console.log(`\n✅ Migration complete!`);
        console.log(`  📊 Contents collection now has:`);
        console.log(`    - ${finalContentVideos} videos`);
        console.log(`    - ${finalContentTotal} total documents`);
        console.log(`\n⚠️  The 'videos' collection has been kept as backup.`);
        console.log(`    You can drop it manually after verifying everything works:`);
        console.log(`    db.videos.drop()`);

        await mongoose.disconnect();
        console.log('\n✅ Disconnected from MongoDB');
    } catch (error) {
        console.error('💥 Migration failed:', error);
        await mongoose.disconnect();
        process.exit(1);
    }
}

migrate();
