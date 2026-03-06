/**
 * Archive Purge Worker
 * 
 * Runs on a configurable interval (default: every 10 minutes).
 * Permanently deletes archived content whose 24-hour grace period has expired.
 * 
 * Deletes:
 *   1. S3 objects: thumbnail, original upload, HLS segments/playlists, images
 *   2. MongoDB: Content document + related Comments, VideoReactions, WatchHistory, ContentViews
 *   3. Updates ContentArchive record to mark as permanently deleted
 * 
 * Usage:
 *   node workers/archivePurgeWorker.js
 * 
 * Or add to your process manager / cron.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

dotenv.config();

// ─── Models ──────────────────────────────────────────────────────────────────
import ContentArchive from '../models/contentArchive.model.js';
import Content from '../models/content.model.js';
import AdminAuditLog from '../models/adminAuditLog.model.js';

// Lazy-import related models only when needed
const PURGE_INTERVAL_MS = parseInt(process.env.PURGE_INTERVAL_MS) || 10 * 60 * 1000; // 10 min

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const S3_BUCKET = process.env.S3_BUCKET;

/**
 * Delete a single S3 object by key.
 */
async function deleteS3Object(key) {
    if (!key) return;
    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    } catch (err) {
        console.error(`  ⚠️ Failed to delete S3 key "${key}":`, err.message);
    }
}

/**
 * Delete all S3 objects under a given prefix (e.g., HLS directory).
 */
async function deleteS3Prefix(prefix) {
    if (!prefix) return;
    try {
        const listed = await s3Client.send(new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: prefix
        }));

        if (listed.Contents && listed.Contents.length > 0) {
            console.log(`  🗑️  Deleting ${listed.Contents.length} objects under prefix "${prefix}"`);
            await Promise.all(
                listed.Contents.map(obj => deleteS3Object(obj.Key))
            );
        }
    } catch (err) {
        console.error(`  ⚠️ Failed to list/delete S3 prefix "${prefix}":`, err.message);
    }
}

/**
 * Process a single archive entry: delete content from S3 + MongoDB.
 */
async function purgeArchivedItem(archive) {
    const contentId = archive.content_id;
    console.log(`\n📦 Purging content: ${contentId} (archived: ${archive.removed_at.toISOString()})`);

    try {
        // 1. Delete S3 objects
        const keysToDelete = [
            archive.originalKey,
            archive.hlsMasterKey,
            archive.thumbnailKey,
            archive.imageKey,
        ].filter(Boolean);

        // Additional image keys
        if (archive.imageKeys && archive.imageKeys.length > 0) {
            keysToDelete.push(...archive.imageKeys.filter(Boolean));
        }

        // Delete individual keys
        if (keysToDelete.length > 0) {
            console.log(`  🗑️  Deleting ${keysToDelete.length} S3 objects`);
            await Promise.all(keysToDelete.map(deleteS3Object));
        }

        // Delete HLS directory (all segments, playlists, variants)
        if (archive.hlsPrefix) {
            await deleteS3Prefix(archive.hlsPrefix);
        }

        // Also try to find and delete the content's original upload path
        // (e.g., uploads/{userId}/{filename})
        const content = await Content.findById(contentId);
        if (content) {
            // Check for any additional S3 keys on the content document
            const extraKeys = [
                content.processedKey,
                content.hlsKey,
            ].filter(Boolean);

            if (extraKeys.length > 0) {
                await Promise.all(extraKeys.map(deleteS3Object));
            }

            // If hlsKey exists, also delete the parent HLS directory
            if (content.hlsMasterKey && !archive.hlsPrefix) {
                const hlsDir = content.hlsMasterKey.substring(0, content.hlsMasterKey.lastIndexOf('/') + 1);
                if (hlsDir) await deleteS3Prefix(hlsDir);
            }
        }

        // 2. Delete related MongoDB documents
        const [Comment, VideoReaction, WatchHistory, ContentView] = await Promise.all([
            import('../models/comment.model.js').then(m => m.default),
            import('../models/videoReaction.model.js').then(m => m.default),
            import('../models/watchHistory.model.js').then(m => m.default),
            import('../models/contentView.model.js').then(m => m.default),
        ]);

        const deleteResults = await Promise.allSettled([
            Comment.deleteMany({ videoId: contentId }),
            VideoReaction.deleteMany({ videoId: contentId }),
            WatchHistory.deleteMany({ contentId }),
            ContentView.deleteMany({ contentId }),
        ]);

        deleteResults.forEach((result, i) => {
            const names = ['Comments', 'Reactions', 'WatchHistory', 'ContentViews'];
            if (result.status === 'fulfilled') {
                console.log(`  ✅ ${names[i]}: ${result.value.deletedCount || 0} deleted`);
            } else {
                console.error(`  ⚠️ ${names[i]}: ${result.reason?.message}`);
            }
        });

        // 3. Delete the Content document itself
        if (content) {
            await Content.findByIdAndDelete(contentId);
            console.log(`  ✅ Content document deleted`);
        }

        // 4. Mark archive as permanently deleted
        archive.permanently_deleted = true;
        archive.permanently_deleted_at = new Date();
        await archive.save();

        // 5. Audit log
        await AdminAuditLog.create({
            admin_id: archive.removed_by_admin,
            action: 'content_purge',
            target_type: 'content',
            target_id: contentId,
            ip: 'system',
            user_agent: 'archive-purge-worker',
            note: `Auto-purged after 24h archive window. Title: "${archive.content_snapshot?.title || 'N/A'}"`
        });

        console.log(`  ✅ Purge complete for ${contentId}`);
    } catch (err) {
        console.error(`  ❌ Error purging ${contentId}:`, err);
    }
}

/**
 * Main purge cycle — find and process all expired archives.
 */
async function runPurgeCycle() {
    const now = new Date();
    console.log(`\n🔄 Purge cycle at ${now.toISOString()}`);

    const expiredArchives = await ContentArchive.find({
        permanently_deleted: false,
        restored_at: null,
        delete_scheduled_at: { $lte: now }
    });

    if (expiredArchives.length === 0) {
        console.log('  ✅ No expired archives to purge');
        return;
    }

    console.log(`  📋 Found ${expiredArchives.length} archive(s) to purge`);

    for (const archive of expiredArchives) {
        await purgeArchivedItem(archive);
    }

    console.log(`\n✅ Purge cycle complete. Processed ${expiredArchives.length} item(s).`);
}

/**
 * OTP cleanup — delete expired OTP sessions.
 */
async function cleanupExpiredOtpSessions() {
    try {
        const OtpSession = (await import('../models/adminOtpSession.model.js')).default;
        const result = await OtpSession.deleteMany({ expires_at: { $lte: new Date() } });
        if (result.deletedCount > 0) {
            console.log(`  🧹 Cleaned up ${result.deletedCount} expired OTP session(s)`);
        }
    } catch (err) {
        console.error('  ⚠️ OTP cleanup error:', err.message);
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

async function main() {
    console.log('🚀 Archive Purge Worker starting...');
    console.log(`   Purge interval: ${PURGE_INTERVAL_MS / 1000}s`);
    console.log(`   S3 Bucket: ${S3_BUCKET}`);

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Run immediately on start
    await runPurgeCycle();
    await cleanupExpiredOtpSessions();

    // Then run on interval
    setInterval(async () => {
        try {
            await runPurgeCycle();
            await cleanupExpiredOtpSessions();
        } catch (err) {
            console.error('❌ Purge cycle error:', err);
        }
    }, PURGE_INTERVAL_MS);
}

main().catch(err => {
    console.error('❌ Worker failed to start:', err);
    process.exit(1);
});
