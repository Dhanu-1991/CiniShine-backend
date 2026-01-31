/**
 * Thumbnail Path Migration Script
 * 
 * This script updates old thumbnail paths to the new folder structure:
 * - Videos: thumbnails/{userId}/{id}.jpg -> thumbnails/videos/{userId}/{id}.jpg
 * - Shorts: thumbnails/{userId}/{id}.jpg -> thumbnails/shorts/{userId}/{id}.jpg
 * - Audio: thumbnails/{userId}/{id}.jpg -> thumbnails/audio/{userId}/{id}.jpg
 * 
 * Run: node scripts/migrateThumbnailPaths.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

// MongoDB connection
const MONGO_URI = process.env.DB_CONNECTION_STRING || process.env.MONGO_URI;

// S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const S3_BUCKET = process.env.S3_BUCKET || 'cini-shine';

// Video Schema (minimal for migration)
const videoSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    thumbnailKey: String,
    thumbnailSource: String,
}, { collection: 'videos', strict: false });

// Content Schema (minimal for migration)
const contentSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    contentType: String,
    thumbnailKey: String,
    thumbnailSource: String,
}, { collection: 'contents', strict: false });

const Video = mongoose.model('Video', videoSchema);
const Content = mongoose.model('Content', contentSchema);

// Check if S3 object exists
async function s3ObjectExists(key) {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
        }));
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw err;
    }
}

// Copy S3 object to new location
async function copyS3Object(sourceKey, destKey) {
    try {
        await s3Client.send(new CopyObjectCommand({
            Bucket: S3_BUCKET,
            CopySource: `${S3_BUCKET}/${sourceKey}`,
            Key: destKey,
        }));
        console.log(`  ✅ Copied: ${sourceKey} -> ${destKey}`);
        return true;
    } catch (err) {
        console.error(`  ❌ Copy failed: ${sourceKey} -> ${destKey}`, err.message);
        return false;
    }
}

// Check if thumbnailKey is in old format (no /videos/, /shorts/, /audio/ subfolder)
function isOldFormat(thumbnailKey) {
    if (!thumbnailKey) return false;
    // Old format: thumbnails/{userId}/{filename}
    // New format: thumbnails/videos/{userId}/{filename} or thumbnails/shorts/{userId}/{filename}
    const parts = thumbnailKey.split('/');
    // Old: ['thumbnails', '{userId}', '{filename}']
    // New: ['thumbnails', 'videos|shorts|audio', '{userId}', '{filename}']
    if (parts.length === 3 && parts[0] === 'thumbnails') {
        return true; // Old format
    }
    return false;
}

// Convert old path to new path
// contentType can be: 'video', 'short', 'audio', 'post' or empty/null
// If empty/null/unknown, defaults to 'videos' folder
function getNewThumbnailKey(oldKey, contentType) {
    // oldKey: thumbnails/{userId}/{filename}
    // newKey: thumbnails/{type}/{userId}/{filename}
    const parts = oldKey.split('/');
    if (parts.length !== 3) return null;

    const [prefix, userId, filename] = parts;

    // Map contentType to folder name (default to 'videos' if empty/unknown)
    let typeFolder;
    switch (contentType) {
        case 'short':
            typeFolder = 'shorts';
            break;
        case 'audio':
            typeFolder = 'audio';
            break;
        case 'video':
        default:
            // For Video model items OR Content items with empty/null contentType
            typeFolder = 'videos';
            break;
    }

    return `${prefix}/${typeFolder}/${userId}/${filename}`;
}

async function migrateVideos(dryRun = false, copyFiles = false) {
    console.log('\n📹 Migrating VIDEO thumbnails...\n');

    const videos = await Video.find({
        thumbnailKey: { $exists: true, $ne: null }
    });

    console.log(`Found ${videos.length} videos with thumbnailKey`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const video of videos) {
        const oldKey = video.thumbnailKey;

        if (!isOldFormat(oldKey)) {
            skipped++;
            continue;
        }

        const newKey = getNewThumbnailKey(oldKey, 'video');
        if (!newKey) {
            console.log(`  ⚠️ Skipping invalid key: ${oldKey}`);
            skipped++;
            continue;
        }

        console.log(`\n🔄 Video ${video._id}:`);
        console.log(`  Old: ${oldKey}`);
        console.log(`  New: ${newKey}`);

        if (dryRun) {
            console.log(`  [DRY RUN] Would update`);
            updated++;
            continue;
        }
        try {
            // Optionally copy file in S3
            if (copyFiles) {
                const sourceExists = await s3ObjectExists(oldKey);
                if (sourceExists) {
                    const copied = await copyS3Object(oldKey, newKey);
                    if (!copied) {
                        errors++;
                        continue;
                    }
                } else {
                    console.log(`  ⚠️ Source file doesn't exist in S3, updating DB only`);
                }
            }

            // Update database
            await Video.updateOne(
                { _id: video._id },
                { $set: { thumbnailKey: newKey } }
            );
            console.log(`  ✅ DB updated`);
            updated++;
        } catch (err) {
            console.error(`  ❌ Error:`, err.message);
            errors++;
        }
    }

    console.log(`\n📊 Videos Summary: ${updated} updated, ${skipped} skipped, ${errors} errors`);
    return { updated, skipped, errors };
}

async function migrateContent(dryRun = false, copyFiles = false) {
    console.log('\n📦 Migrating CONTENT thumbnails (shorts, audio, posts)...\n');

    const contents = await Content.find({
        thumbnailKey: { $exists: true, $ne: null }
    });

    console.log(`Found ${contents.length} content items with thumbnailKey`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const content of contents) {
        const oldKey = content.thumbnailKey;

        if (!isOldFormat(oldKey)) {
            skipped++;
            continue;
        }

        const newKey = getNewThumbnailKey(oldKey, content.contentType);
        if (!newKey) {
            console.log(`  ⚠️ Skipping invalid key: ${oldKey}`);
            skipped++;
            continue;
        }

        console.log(`\n🔄 Content ${content._id} (${content.contentType}):`);
        console.log(`  Old: ${oldKey}`);
        console.log(`  New: ${newKey}`);

        if (dryRun) {
            console.log(`  [DRY RUN] Would update`);
            updated++;
            continue;
        }

        try {
            // Optionally copy file in S3
            if (copyFiles) {
                const sourceExists = await s3ObjectExists(oldKey);
                if (sourceExists) {
                    const copied = await copyS3Object(oldKey, newKey);
                    if (!copied) {
                        errors++;
                        continue;
                    }
                } else {
                    console.log(`  ⚠️ Source file doesn't exist in S3, updating DB only`);
                }
            }

            // Update database
            await Content.updateOne(
                { _id: content._id },
                { $set: { thumbnailKey: newKey } }
            );
            console.log(`  ✅ DB updated`);
            updated++;
        } catch (err) {
            console.error(`  ❌ Error:`, err.message);
            errors++;
        }
    }

    console.log(`\n📊 Content Summary: ${updated} updated, ${skipped} skipped, ${errors} errors`);
    return { updated, skipped, errors };
}

async function main() {
    // Parse command line args
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const copyFiles = args.includes('--copy-s3');

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('          THUMBNAIL PATH MIGRATION SCRIPT');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`\nMode: ${dryRun ? '🔍 DRY RUN (no changes)' : '🚀 LIVE (making changes)'}`);
    console.log(`S3 Copy: ${copyFiles ? '✅ Enabled' : '❌ Disabled (DB only)'}`);
    console.log(`Bucket: ${S3_BUCKET}`);
    console.log('');

    if (!MONGO_URI) {
        console.error('❌ ERROR: DB_CONNECTION_STRING or MONGO_URI not set in .env');
        process.exit(1);
    }

    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const videoResults = await migrateVideos(dryRun, copyFiles);
        const contentResults = await migrateContent(dryRun, copyFiles);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('                    FINAL SUMMARY');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`Videos:  ${videoResults.updated} updated, ${videoResults.skipped} skipped, ${videoResults.errors} errors`);
        console.log(`Content: ${contentResults.updated} updated, ${contentResults.skipped} skipped, ${contentResults.errors} errors`);
        console.log(`Total:   ${videoResults.updated + contentResults.updated} updated`);
        console.log('═══════════════════════════════════════════════════════════════\n');

        if (dryRun) {
            console.log('💡 This was a DRY RUN. To apply changes, run without --dry-run flag.');
            console.log('   To also copy S3 files, add --copy-s3 flag.\n');
        }

    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

main();
