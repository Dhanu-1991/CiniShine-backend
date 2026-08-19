/**
 * Migration Script: Recalculate and populate cached subscriberCount for all creators
 *
 * This script:
 * 1. Finds all users who have active subscriptions to other users/creators.
 * 2. Aggregates the exact count of subscribers for each creator ID.
 * 3. Ensures all users without subscribers have subscriberCount: 0.
 * 4. Bulk updates each creator's subscriberCount to match their real subscriber count.
 *
 * Usage:
 * - Standalone: node scripts/migrateSubscriberCounts.js (or node backend/scripts/migrateSubscriberCounts.js)
 * - Auto-run on boot: imported and called in backend/index.js after MongoDB connection
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/user.model.js';

dotenv.config();

/**
 * Executes the subscriber count migration.
 * @param {boolean} isBoot - If true, called as part of server startup (won't disconnect mongoose or exit process)
 * @returns {Promise<{ totalUsers: number, creatorsWithSubscribers: number, totalSubscribersSynced: number, initializedCount: number }>}
 */
export async function runSubscriberCountMigration(isBoot = false) {
    const startTime = Date.now();
    console.log('\n======================================================');
    console.log('🔄 [Migration] Starting subscriber count migration...');
    console.log('======================================================');

    const isAlreadyConnected = mongoose.connection.readyState === 1;

    try {
        if (!isAlreadyConnected) {
            const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
            if (!uri) {
                throw new Error('No MONGO_URI or MONGODB_URI found in environment variables');
            }
            console.log('🔌 [Migration] Connecting to MongoDB...');
            await mongoose.connect(uri, {
                serverSelectionTimeoutMS: 15000,
            });
            console.log('✅ [Migration] Connected to MongoDB');
        }

        const totalUsers = await User.countDocuments();
        console.log(`👥 [Migration] Total users in database: ${totalUsers}`);

        if (totalUsers === 0) {
            console.log('⚠️ [Migration] No users found in database. Nothing to migrate.');
            console.log('======================================================\n');
            return { totalUsers: 0, creatorsWithSubscribers: 0, totalSubscribersSynced: 0, initializedCount: 0 };
        }

        // 1. Initialize any users missing the subscriberCount field or having null
        const initResult = await User.updateMany(
            {
                $or: [
                    { subscriberCount: { $exists: false } },
                    { subscriberCount: null },
                ]
            },
            { $set: { subscriberCount: 0 } }
        );
        console.log(`🧹 [Migration] Initialized missing subscriberCount to 0 for ${initResult.modifiedCount} user(s)`);

        // 2. Aggregate actual subscriber counts by unwinding users' subscriptions array
        const aggregationResult = await User.aggregate([
            {
                $match: {
                    subscriptions: { $exists: true, $type: 'array', $ne: [] }
                }
            },
            { $unwind: '$subscriptions' },
            {
                $match: {
                    subscriptions: { $ne: null }
                }
            },
            {
                $group: {
                    _id: '$subscriptions',
                    actualCount: { $sum: 1 }
                }
            }
        ]);

        console.log(`📊 [Migration] Found ${aggregationResult.length} creator(s) with at least 1 subscriber`);

        const creatorIdsWithSubscribers = aggregationResult.map(r => r._id);

        // 3. Reset subscriberCount to 0 for users who have 0 subscribers but might have a non-zero stale count
        const resetResult = await User.updateMany(
            {
                _id: { $nin: creatorIdsWithSubscribers },
                subscriberCount: { $gt: 0 }
            },
            { $set: { subscriberCount: 0 } }
        );
        if (resetResult.modifiedCount > 0) {
            console.log(`🔄 [Migration] Reset stale non-zero subscriberCount to 0 for ${resetResult.modifiedCount} user(s)`);
        }

        // 4. Bulk update creators who have subscribers in batches
        let totalSubscribersSynced = 0;
        let creatorsUpdated = 0;

        if (aggregationResult.length > 0) {
            const BATCH_SIZE = 500;
            for (let i = 0; i < aggregationResult.length; i += BATCH_SIZE) {
                const batch = aggregationResult.slice(i, i + BATCH_SIZE);
                const bulkOps = batch.map(item => ({
                    updateOne: {
                        filter: { _id: item._id },
                        update: { $set: { subscriberCount: item.actualCount } }
                    }
                }));

                const bulkWriteResult = await User.bulkWrite(bulkOps, { ordered: false });
                creatorsUpdated += (bulkWriteResult.modifiedCount || 0) + (bulkWriteResult.matchedCount || 0);

                batch.forEach(item => {
                    totalSubscribersSynced += item.actualCount;
                });
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('------------------------------------------------------');
        console.log('✅ [Migration] Subscriber count migration completed successfully!');
        console.log(`⏱️ [Migration] Time taken: ${duration}s`);
        console.log(`📊 [Migration] Summary:`);
        console.log(`   - Total users scanned: ${totalUsers}`);
        console.log(`   - Creators with subscribers updated: ${aggregationResult.length}`);
        console.log(`   - Total active subscriptions synced: ${totalSubscribersSynced}`);
        console.log(`   - Default initialized count: ${initResult.modifiedCount}`);
        console.log('======================================================\n');

        return {
            totalUsers,
            creatorsWithSubscribers: aggregationResult.length,
            totalSubscribersSynced,
            initializedCount: initResult.modifiedCount,
        };

    } catch (error) {
        console.error('❌ [Migration] Error during subscriber count migration:', error);
        if (!isBoot) {
            throw error;
        }
    } finally {
        if (!isAlreadyConnected && !isBoot) {
            await mongoose.disconnect();
            console.log('🔌 [Migration] MongoDB connection closed');
        }
    }
}

// Support direct command-line execution: node scripts/migrateSubscriberCounts.js
const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (executedFilePath === currentFilePath || executedFilePath.endsWith('migrateSubscriberCounts.js')) {
    runSubscriberCountMigration(false)
        .then(() => {
            console.log('🏁 Script finished.');
            process.exit(0);
        })
        .catch((err) => {
            console.error('💥 Fatal migration error:', err);
            process.exit(1);
        });
}
