/**
 * Migration Script: Fix Inflated Watchtime Data
 *
 * Problem:
 *   The old watchtime tracking created a NEW ContentWatchtime record for every heartbeat
 *   (every 10 seconds), each containing the CUMULATIVE activePlayTime. When the analytics
 *   dashboard sums activePlayTime across all records, the total is wildly inflated.
 *   Example: a 5-minute video creates ~30 records with values 10, 20, 30...300,
 *   summing to 4,650 seconds instead of the correct 300.
 *
 * Fix Strategy:
 *   1. Group ContentWatchtime records by (watchSessionId + contentId).
 *   2. For each group with multiple records, keep only the one with the HIGHEST
 *      activePlayTime (which represents the final cumulative total for that session).
 *   3. Delete the duplicate (intermediate heartbeat) records.
 *   4. Recompute Content.totalWatchTime for all affected content from the cleaned data.
 *
 * Usage:
 *   cd backend
 *   node --env-file=.env fixWatchtimeData.js
 *
 *   Or with MONGODB_URI directly:
 *   MONGODB_URI="mongodb+srv://..." node fixWatchtimeData.js
 */

import mongoose from 'mongoose';
import ContentWatchtime from './models/contentWatchtime.model.js';
import Content from './models/content.model.js';
import WatchHistory from './models/watchHistory.model.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mydb';


async function fixWatchtimeData() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // ─── STEP 1: Diagnostic Audit & Find duplicate watch session records ───
        console.log('\n📊 Step 1: Auditing Database Watchtime Collections...');

        const [totalRecords, totalWatchHistory, totalContent] = await Promise.all([
            ContentWatchtime.countDocuments({}),
            WatchHistory.countDocuments({}),
            Content.countDocuments({}),
        ]);

        console.log(`   - ContentWatchtime records: ${totalRecords}`);
        console.log(`   - WatchHistory records:      ${totalWatchHistory}`);
        console.log(`   - Content records:           ${totalContent}`);

        // Check if any Content has inflated totalWatchTime
        const contentWithWatchtime = await Content.find({ totalWatchTime: { $gt: 0 } }).select('_id title totalWatchTime duration views').lean();
        if (contentWithWatchtime.length > 0) {
            console.log('\n   📹 Content items with non-zero watchtime:');
            for (const c of contentWithWatchtime) {
                console.log(`      - [${c._id}] "${c.title || 'Untitled'}" — totalWatchTime: ${c.totalWatchTime}s (${Math.round(c.totalWatchTime / 60)}m), duration: ${c.duration || 0}s, views: ${c.views || 0}`);
            }
        } else {
            console.log('   ℹ️  No Content items currently have non-zero totalWatchTime.');
        }

        if (totalRecords === 0) {
            console.log('\n   ✅ ContentWatchtime is currently empty. All future watch sessions will use the fixed upsert logic.');
            await mongoose.disconnect();
            return;
        }


        const sampleRecord = await ContentWatchtime.findOne({}).lean();
        console.log('   Sample record structure:', {
            _id: sampleRecord._id,
            contentId: sampleRecord.contentId,
            watchSessionId: sampleRecord.watchSessionId,
            sessionId: sampleRecord.sessionId,
            userId: sampleRecord.userId,
            anonymousViewerId: sampleRecord.anonymousViewerId,
            activePlayTime: sampleRecord.activePlayTime,
            eventType: sampleRecord.eventType,
            dateBucket: sampleRecord.dateBucket,
        });

        // 1A. Group by watchSessionId + contentId (if watchSessionId is present)
        let duplicateSessions = await ContentWatchtime.aggregate([
            { $match: { watchSessionId: { $ne: null, $exists: true } } },
            {
                $group: {
                    _id: { watchSessionId: '$watchSessionId', contentId: '$contentId' },
                    count: { $sum: 1 },
                    maxActivePlayTime: { $max: '$activePlayTime' },
                    records: {
                        $push: {
                            recordId: '$_id',
                            activePlayTime: '$activePlayTime',
                            eventType: '$eventType',
                            createdAt: '$createdAt',
                        }
                    },
                },
            },
            { $match: { count: { $gt: 1 } } },
            { $sort: { count: -1 } },
        ]);

        console.log(`   Found ${duplicateSessions.length} duplicate sessions grouped by (watchSessionId + contentId).`);

        // 1B. Fallback: If 0 found by watchSessionId, try grouping by sessionId + contentId
        if (duplicateSessions.length === 0) {
            console.log('   Checking fallback: grouping by (sessionId + contentId)...');
            duplicateSessions = await ContentWatchtime.aggregate([
                { $match: { sessionId: { $ne: null, $exists: true } } },
                {
                    $group: {
                        _id: { watchSessionId: '$sessionId', contentId: '$contentId' },
                        count: { $sum: 1 },
                        maxActivePlayTime: { $max: '$activePlayTime' },
                        records: {
                            $push: {
                                recordId: '$_id',
                                activePlayTime: '$activePlayTime',
                                eventType: '$eventType',
                                createdAt: '$createdAt',
                            }
                        },
                    },
                },
                { $match: { count: { $gt: 1 } } },
                { $sort: { count: -1 } },
            ]);
            console.log(`   Found ${duplicateSessions.length} duplicate sessions grouped by (sessionId + contentId).`);
        }

        // 1C. Fallback 2: Group by viewer (userId / anonymousViewerId) + contentId + dateBucket
        if (duplicateSessions.length === 0) {
            console.log('   Checking fallback: grouping by (viewer + contentId + dateBucket)...');
            duplicateSessions = await ContentWatchtime.aggregate([
                {
                    $group: {
                        _id: {
                            viewer: { $ifNull: ['$userId', '$anonymousViewerId'] },
                            contentId: '$contentId',
                            dateBucket: '$dateBucket'
                        },
                        count: { $sum: 1 },
                        maxActivePlayTime: { $max: '$activePlayTime' },
                        records: {
                            $push: {
                                recordId: '$_id',
                                activePlayTime: '$activePlayTime',
                                eventType: '$eventType',
                                createdAt: '$createdAt',
                            }
                        },
                    },
                },
                { $match: { count: { $gt: 1 } } },
                { $sort: { count: -1 } },
            ]);
            console.log(`   Found ${duplicateSessions.length} duplicate viewer-content sessions per day.`);
        }


        // ─── STEP 2: For each session, keep the best record, delete the rest ─
        console.log('\n🧹 Step 2: Consolidating duplicate records...');

        let totalDeleted = 0;
        let totalSessions = duplicateSessions.length;
        let batchSize = 100;
        const affectedContentIds = new Set();

        for (let i = 0; i < duplicateSessions.length; i += batchSize) {
            const batch = duplicateSessions.slice(i, i + batchSize);
            const idsToDelete = [];

            for (const session of batch) {
                const records = session.records;

                // Find the "best" record: highest activePlayTime.
                // If multiple have the same max, prefer 'ended' > 'unload' > 'pagehide' > latest createdAt
                const priorityOrder = { ended: 0, unload: 1, pagehide: 2 };
                const sorted = records.sort((a, b) => {
                    // Highest activePlayTime first
                    if (b.activePlayTime !== a.activePlayTime) return b.activePlayTime - a.activePlayTime;
                    // Prefer session-end events
                    const aPri = priorityOrder[a.eventType] ?? 99;
                    const bPri = priorityOrder[b.eventType] ?? 99;
                    if (aPri !== bPri) return aPri - bPri;
                    // Latest createdAt
                    return new Date(b.createdAt) - new Date(a.createdAt);
                });

                // Keep the first (best), delete the rest
                for (let j = 1; j < sorted.length; j++) {
                    idsToDelete.push(sorted[j].recordId);
                }

                // Track affected content
                affectedContentIds.add(session._id.contentId.toString());
            }

            if (idsToDelete.length > 0) {
                const result = await ContentWatchtime.deleteMany({ _id: { $in: idsToDelete } });
                totalDeleted += result.deletedCount;
            }

            if ((i + batchSize) % 1000 === 0 || i + batchSize >= totalSessions) {
                console.log(`   Processed ${Math.min(i + batchSize, totalSessions)}/${totalSessions} sessions, deleted ${totalDeleted} records so far...`);
            }
        }

        console.log(`   ✅ Deleted ${totalDeleted} duplicate ContentWatchtime records.`);
        console.log(`   📦 ${affectedContentIds.size} content items affected.`);

        // ─── STEP 3: Recompute Content.totalWatchTime from cleaned data ─────
        console.log('\n🔄 Step 3: Recomputing Content.totalWatchTime for all content...');

        // Recompute for ALL content to fix any historical inflation
        const watchtimeSums = await ContentWatchtime.aggregate([
            {
                $group: {
                    _id: '$contentId',
                    correctTotalWatchTime: { $sum: '$activePlayTime' },
                }
            }
        ]);

        console.log(`   Computing correct totals for ${watchtimeSums.length} content items...`);

        let updatedCount = 0;
        let unchangedCount = 0;
        let fixedCount = 0;

        for (let i = 0; i < watchtimeSums.length; i += batchSize) {
            const batch = watchtimeSums.slice(i, i + batchSize);
            const bulkOps = [];

            for (const item of batch) {
                // Get current value
                const content = await Content.findById(item._id).select('totalWatchTime').lean();
                if (!content) continue;

                const currentTotal = content.totalWatchTime || 0;
                const correctTotal = Math.round(item.correctTotalWatchTime);

                if (currentTotal !== correctTotal) {
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: item._id },
                            update: { $set: { totalWatchTime: correctTotal } },
                        }
                    });
                    fixedCount++;

                    // Log significant corrections
                    if (currentTotal > correctTotal * 2) {
                        console.log(`   ⚠️  Content ${item._id}: ${currentTotal}s → ${correctTotal}s (was ${Math.round(currentTotal / correctTotal)}x inflated)`);
                    }
                } else {
                    unchangedCount++;
                }
            }

            if (bulkOps.length > 0) {
                await Content.bulkWrite(bulkOps);
                updatedCount += bulkOps.length;
            }

            if ((i + batchSize) % 500 === 0 || i + batchSize >= watchtimeSums.length) {
                console.log(`   Processed ${Math.min(i + batchSize, watchtimeSums.length)}/${watchtimeSums.length}...`);
            }
        }

        console.log(`\n✅ Migration complete!`);
        console.log(`   📊 Summary:`);
        console.log(`      - Duplicate records deleted: ${totalDeleted}`);
        console.log(`      - Content totalWatchTime corrected: ${fixedCount}`);
        console.log(`      - Content totalWatchTime unchanged: ${unchangedCount}`);

    } catch (error) {
        console.error('❌ Migration error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB.');
    }
}

fixWatchtimeData();
