/**
 * Migration Script: Auto-generate profiles for non-profile users
 * 
 * This script finds all users without channelName/channelHandle and creates
 * default profiles for them using their username as the channel name.
 * 
 * Usage: node scripts/migrateNonProfileUsers.js
 */

import mongoose from 'mongoose';
import User from '../models/user.model.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';

async function generateUniqueHandle(baseHandle) {
    let handle = baseHandle.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    let counter = 1;
    let finalHandle = handle;

    while (true) {
        const existing = await User.findOne({ channelHandle: finalHandle }).lean();
        if (!existing) {
            return finalHandle;
        }
        finalHandle = `${handle}${counter}`;
        counter++;
        if (counter > 10000) {
            // Fallback with timestamp if we can't find a unique handle
            finalHandle = `${handle}_${Date.now()}`;
            break;
        }
    }
    return finalHandle;
}

async function migrateNonProfileUsers() {
    try {
        console.log('🚀 Starting migration for non-profile users...\n');

        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to MongoDB\n');

        // Find users without channelName (non-profile users)
        const nonProfileUsers = await User.find({
            $or: [
                { channelName: { $exists: false } },
                { channelName: null },
                { channelName: '' }
            ]
        }).select('_id userName contact createdAt').lean();

        console.log(`📊 Found ${nonProfileUsers.length} users without profiles\n`);

        if (nonProfileUsers.length === 0) {
            console.log('✨ All users already have profiles. No migration needed.');
            await mongoose.connection.close();
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        // Migrate each user
        for (let i = 0; i < nonProfileUsers.length; i++) {
            const user = nonProfileUsers[i];

            try {
                // Auto-generate handles and names from existing data
                const channelName = user.userName || `User_${user._id.toString().slice(-8)}`;
                const baseHandle = user.contact?.replace(/[^a-z0-9_]/gi, '').toLowerCase() ||
                    user.userName?.replace(/[^a-z0-9_]/gi, '').toLowerCase() ||
                    `user_${user._id.toString().slice(-8)}`;

                const channelHandle = await generateUniqueHandle(baseHandle);

                // Update user with generated profile
                const updated = await User.findByIdAndUpdate(
                    user._id,
                    {
                        channelName: channelName,
                        channelHandle: channelHandle,
                        channelDescription: `Welcome to my channel!`
                    },
                    { new: true }
                );

                successCount++;

                // Log progress every 50 users
                if ((i + 1) % 50 === 0) {
                    console.log(`⏳ Progress: ${i + 1}/${nonProfileUsers.length} users migrated...`);
                }

                // Detailed log for first 10 and last few
                if (i < 10 || i >= nonProfileUsers.length - 5) {
                    console.log(`  ✓ User ${user._id}`);
                    console.log(`    • Channel Name: ${channelName}`);
                    console.log(`    • Channel Handle: ${channelHandle}`);
                }

            } catch (error) {
                errorCount++;
                console.error(`  ❌ Error migrating user ${user._id}: ${error.message}`);
            }
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log('📈 Migration Summary:');
        console.log(`   Total users processed: ${nonProfileUsers.length}`);
        console.log(`   ✅ Successfully migrated: ${successCount}`);
        console.log(`   ❌ Failed: ${errorCount}`);
        console.log(`${'='.repeat(60)}\n`);

        if (errorCount === 0) {
            console.log('🎉 Migration completed successfully! All non-profile users now have profiles.');
        } else {
            console.log(`⚠️  Migration completed with ${errorCount} errors. Please review the errors above.`);
        }

        await mongoose.connection.close();
        console.log('✅ Database connection closed');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

// Run the migration
migrateNonProfileUsers().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
