/**
 * Migration Script: Add channelHandle to existing users with channels
 *
 * Finds all users who have a channelName but no channelHandle,
 * generates a handle from their channelName, ensures uniqueness,
 * and updates the user document.
 *
 * Usage: node scripts/migrateChannelHandles.js
 *
 * IMPORTANT:
 * - Back up your database before running
 * - Safe to run multiple times (idempotent — skips users who already have a handle)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Generate a handle from a channel name
 * e.g. "My Cool Channel" → "my_cool_channel"
 */
function generateHandle(channelName) {
    if (!channelName) return '';
    const trimmed = channelName.trim();
    let handle = trimmed
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
    if (handle && !/^[a-zA-Z]/.test(handle)) {
        handle = 'ch_' + handle;
    }
    return handle.toLowerCase();
}

async function migrate() {
    try {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!uri) {
            console.error('❌ No MONGODB_URI or MONGO_URI found in environment');
            process.exit(1);
        }

        console.log('🔌 Connecting to MongoDB…');
        await mongoose.connect(uri);
        console.log('✅ Connected');

        const User = mongoose.connection.collection('users');

        // Find users with channelName but no channelHandle
        const usersToMigrate = await User.find({
            channelName: { $exists: true, $ne: null, $ne: '' },
            $or: [
                { channelHandle: { $exists: false } },
                { channelHandle: null },
                { channelHandle: '' },
            ],
        }).toArray();

        console.log(`📋 Found ${usersToMigrate.length} users needing a channelHandle`);

        if (usersToMigrate.length === 0) {
            console.log('✅ Nothing to migrate — all users already have handles');
            await mongoose.disconnect();
            return;
        }

        // Collect all existing handles so we can check uniqueness in-memory
        const existingHandles = new Set();
        const allHandles = await User.find(
            { channelHandle: { $exists: true, $ne: null, $ne: '' } },
            { projection: { channelHandle: 1 } }
        ).toArray();
        allHandles.forEach((u) => existingHandles.add(u.channelHandle));

        let migrated = 0;
        let skipped = 0;

        for (const user of usersToMigrate) {
            const baseHandle = generateHandle(user.channelName);
            if (!baseHandle) {
                console.warn(`⚠️  Skipping user ${user._id} — empty handle from channelName "${user.channelName}"`);
                skipped++;
                continue;
            }

            // Make unique
            let handle = baseHandle;
            let suffix = 0;
            while (existingHandles.has(handle)) {
                suffix++;
                handle = `${baseHandle}${suffix}`;
            }

            // Update
            await User.updateOne(
                { _id: user._id },
                { $set: { channelHandle: handle } }
            );

            existingHandles.add(handle);
            migrated++;
            console.log(`  ✔ ${user.channelName} → @${handle}`);
        }

        console.log(`\n🎉 Migration complete: ${migrated} migrated, ${skipped} skipped`);
        await mongoose.disconnect();
    } catch (err) {
        console.error('💥 Migration error:', err);
        process.exit(1);
    }
}

migrate();
