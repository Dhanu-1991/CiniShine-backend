import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Comment from '../../models/comment.model.js';
import ContentShare from '../../models/contentShare.model.js';
import EngagementPayout from '../../models/engagementPayout.model.js';
import OtpSession from '../../models/adminOtpSession.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { sendOtpToPhone } from '../auth-controllers/services/otpServicePhone.js';
import { sendAdminEmail } from '../../services/adminEmailService.js';
import crypto from 'crypto';

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_CPM = 200;           // ₹200 per 1K views (max theoretical rate)
const MIN_VIEWS_FOR_PAYOUT = 10; // Minimum delta views to qualify
const MIN_WATCH_PERCENT = 5;     // Minimum avg watch % to qualify
const BAYESIAN_PRIOR_WEIGHT = 100; // Smoothing factor for rate estimation
const MAX_PAYOUT_PER_CONTENT = 50000; // ₹50K cap per content per cycle

// Expected baseline rates for Bayesian smoothing
const PRIOR_LIKE_RATE = 0.03;    // 3% is a normal like rate
const PRIOR_COMMENT_RATE = 0.01; // 1% is a normal comment rate
const PRIOR_SHARE_RATE = 0.005;  // 0.5% is a normal share rate

// Quality score thresholds for normalization (what score = 1.0)
const FULL_WATCH_PERCENT = 70;    // 70% avg watch = perfect score
const FULL_COMPLETION_RATE = 80;  // 80% completion = perfect score
const FULL_LIKE_RATE = 0.05;      // 5% adj. like rate = perfect score
const FULL_COMMENT_RATE = 0.02;   // 2% adj. comment rate = perfect score
const FULL_SHARE_RATE = 0.01;     // 1% adj. share rate = perfect score
const FULL_DURATION_MINUTES = 10; // 10+ minute content = full duration score

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

/**
 * Bayesian-smoothed rate estimation.
 * Prevents edge cases where low sample sizes produce extreme rates.
 * E.g., 5 views + 5 likes = 100% like rate → smoothed to ~5.7% with prior weight 100.
 */
function bayesianRate(observed, sampleSize, priorRate, priorWeight = BAYESIAN_PRIOR_WEIGHT) {
    return (observed + priorRate * priorWeight) / (sampleSize + priorWeight);
}

/**
 * Compute engagement quality score and payout for a single content item.
 * Uses delta-based views (only new views since last payout).
 * 
 * @param {Object} content - Content document with engagement metrics
 * @param {number} commentCount - Pre-fetched comment count
 * @param {number} shareCount - Pre-fetched share count (from ContentShare)
 * @param {number} baseCpm - Base CPM in ₹ per 1K views (default 200)
 * @returns {Object} Payout calculation result
 */
function calculateContentPayout(content, commentCount, shareCount, baseCpm = BASE_CPM) {
    const totalViews = content.views || 0;
    // Number.isFinite covers both undefined and null — MongoDB does NOT backfill defaults
    // to existing documents, so lastEngagementPayoutViews is undefined (not 0) on old content.
    // If undefined → first-ever payout → all current views count as delta (baseline = 0).
    // If 0 explicitly stored → content was checked before but had 0 views → still 0 baseline.
    const previousPaidViews = Number.isFinite(content.lastEngagementPayoutViews)
        ? content.lastEngagementPayoutViews
        : 0;
    const deltaViews = Math.max(totalViews - previousPaidViews, 0);

    // ── Skip guards ──────────────────────────────────────────────────────
    if (deltaViews < MIN_VIEWS_FOR_PAYOUT) {
        return { skip: true, reason: `Insufficient new views (${deltaViews} < ${MIN_VIEWS_FOR_PAYOUT} minimum)`, deltaViews };
    }

    const avgWatchPercent = content.averageWatchPercent || 0;
    // Only skip on very low watch percent if content has significant views (>100)
    // For small view counts, watch percent data can be unreliable
    if (avgWatchPercent < MIN_WATCH_PERCENT && deltaViews > 100) {
        return { skip: true, reason: `Average watch % too low (${avgWatchPercent.toFixed(1)}% < ${MIN_WATCH_PERCENT}% minimum)`, deltaViews };
    }

    const duration = content.duration || 0;
    // Skip non-short content under 10 seconds (likely spam/error uploads)
    if (duration > 0 && duration < 10 && content.contentType !== 'short') {
        return { skip: true, reason: `Content too short (${duration}s, non-short type)`, deltaViews };
    }

    // ── Bayesian-smoothed engagement rates ───────────────────────────────
    const likes = content.likeCount || 0;
    const adjLikeRate = bayesianRate(likes, totalViews, PRIOR_LIKE_RATE);

    const adjCommentRate = bayesianRate(commentCount, totalViews, PRIOR_COMMENT_RATE);

    const adjShareRate = bayesianRate(shareCount, totalViews, PRIOR_SHARE_RATE);

    // ── Quality score components (each 0.0 to 1.0) ──────────────────────
    const watchTimeScore = clamp(avgWatchPercent / FULL_WATCH_PERCENT, 0, 1);
    const completionScore = clamp((content.completionRate || 0) / FULL_COMPLETION_RATE, 0, 1);
    const likeScore = clamp(adjLikeRate / FULL_LIKE_RATE, 0, 1);
    const commentScore = clamp(adjCommentRate / FULL_COMMENT_RATE, 0, 1);
    const shareScore = clamp(adjShareRate / FULL_SHARE_RATE, 0, 1);

    // Duration factor: longer content gets slight bonus (more creator effort)
    const durationMinutes = duration / 60;
    const durationScore = clamp(durationMinutes / FULL_DURATION_MINUTES, 0.3, 1.0);

    // ── Weighted Quality Score (0.2 – 1.0 range) ────────────────────────
    const qualityScore = watchTimeScore * 0.30
                       + completionScore * 0.25
                       + likeScore * 0.15
                       + commentScore * 0.10
                       + shareScore * 0.10
                       + durationScore * 0.10;

    // ── Engagement Multiplier ────────────────────────────────────────────
    // Maps qualityScore to a multiplier that yields ~₹125-150 for normal engagement
    // Normal engagement ≈ qualityScore ~0.65 → multiplier ~0.955 → ₹191/1K
    // But with baseCpm=200, at multiplier 0.65: 200*0.65 = ₹130/1K ✓
    // Let's use: multiplier = qualityScore directly (0.2 to 1.0)
    // Normal: 0.65 * 200 = ₹130/1K ✓
    // Excellent: 0.9 * 200 = ₹180/1K
    // Poor: 0.35 * 200 = ₹70/1K
    const engagementMultiplier = qualityScore;

    // ── Calculate payout amount ──────────────────────────────────────────
    let payoutAmount = (deltaViews / 1000) * baseCpm * engagementMultiplier;

    // Apply per-content cap
    payoutAmount = Math.min(payoutAmount, MAX_PAYOUT_PER_CONTENT);

    // Round to 2 decimal places
    payoutAmount = Math.round(payoutAmount * 100) / 100;

    return {
        skip: false,
        deltaViews,
        previousPaidViews,
        totalViews,
        engagementScore: qualityScore * 100,
        engagementMultiplier,
        payoutAmount,
        metrics: {
            views: totalViews,
            deltaViews,
            previousPaidViews,
            totalWatchTime: content.totalWatchTime || 0,
            avgWatchPercent,
            completionRate: content.completionRate || 0,
            duration,
            likes,
            dislikes: content.dislikeCount || 0,
            shares: shareCount,
            comments: commentCount,
        }
    };
}

/**
 * Compute growth factor for content based on recent vs historical view velocity.
 * Content that's gaining views faster than its historical average gets a bonus.
 * 
 * @param {Object} content - Content document
 * @param {Date} periodStart - Start of the current payout period
 * @returns {number} Growth factor (0.8 – 1.3)
 */
function computeGrowthFactor(content, periodStart) {
    const totalViews = content.views || 0;
    const previousPaidViews = content.lastEngagementPayoutViews || content.paidViews || 0;
    const deltaViews = Math.max(totalViews - previousPaidViews, 0);
    
    const now = new Date();
    const publishedAt = content.publishedAt || content.createdAt || now;
    const totalDays = Math.max(1, (now - publishedAt) / (1000 * 60 * 60 * 24));
    const periodDays = Math.max(1, (now - (periodStart || publishedAt)) / (1000 * 60 * 60 * 24));
    
    const historicalDailyVelocity = totalViews / totalDays;
    const recentDailyVelocity = deltaViews / periodDays;
    
    if (historicalDailyVelocity <= 0) return 1.0;
    
    const growthRatio = recentDailyVelocity / historicalDailyVelocity;
    return clamp(growthRatio, 0.8, 1.3);
}

/**
 * Batch-fetch comment and share counts for multiple content IDs.
 * Eliminates N+1 query problem.
 */
async function batchFetchEngagementCounts(contentIds) {
    const [commentAgg, shareAgg] = await Promise.all([
        Comment.aggregate([
            { $match: { videoId: { $in: contentIds } } },
            { $group: { _id: '$videoId', count: { $sum: 1 } } }
        ]),
        ContentShare.aggregate([
            { $match: { contentId: { $in: contentIds } } },
            { $group: { _id: '$contentId', count: { $sum: 1 } } }
        ])
    ]);

    const commentMap = new Map(commentAgg.map(c => [c._id.toString(), c.count]));
    const shareMap = new Map(shareAgg.map(s => [s._id.toString(), s.count]));
    return { commentMap, shareMap };
}

// ─── OTP ─────────────────────────────────────────────────────────────────────

export const sendEngagementPayoutOtp = async (req, res) => {
    try {
        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: "Admin authentication required or contact details missing" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const channel = contact.includes('@') ? 'email' : 'sms';

        await OtpSession.deleteMany({ contact, purpose: 'engagement_payout' });

        await OtpSession.create({
            admin_id: req.admin._id,
            contact,
            otp_hash: crypto.createHash('sha256').update(otp).digest('hex'),
            channel,
            purpose: 'engagement_payout',
            expires_at: new Date(Date.now() + 5 * 60 * 1000)
        });

        let sent = false;
        try {
            if (channel === 'email') {
                sent = await sendOtpToEmail(contact, otp, 'engagement_payout');
            } else {
                sent = await sendOtpToPhone(contact, otp);
            }
        } catch (emailErr) {
            console.error('⚠️ OTP email dispatch error:', emailErr.message);
        }

        console.log(`\n=================== [ADMIN_ENGAGEMENT_OTP] ===================`);
        console.log(`🔑 OTP for Admin (${contact}): [ ${otp} ]`);
        console.log(`==============================================================\n`);

        return res.json({
            success: true,
            message: sent 
                ? `OTP sent successfully to admin contact (${contact})`
                : `OTP generated for admin (${contact}): ${otp}`
        });
    } catch (error) {
        console.error('❌ Error sending engagement payout OTP:', error);
        return res.status(500).json({ error: 'Failed to send OTP' });
    }
};

// ─── BULK ENGAGEMENT PAYOUT ──────────────────────────────────────────────────

export const runEngagementPayout = async (req, res) => {
    try {
        const { otp, minViews = MIN_VIEWS_FOR_PAYOUT, selectedContentIds, selectedCreatorIds } = req.body;
        
        if (!otp) {
            return res.status(400).json({ error: "Admin OTP is required to initiate engagement payout" });
        }

        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: "Admin contact details missing" });
        }

        // ── Verify OTP ───────────────────────────────────────────────────
        const otpSession = await OtpSession.findOne({
            contact,
            purpose: 'engagement_payout',
            expires_at: { $gt: new Date() }
        });

        if (!otpSession) {
            return res.status(400).json({ error: "OTP expired or not requested. Please request a new OTP." });
        }

        const otpHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
        if (otpSession.otp_hash !== otpHash) {
            otpSession.attempts = (otpSession.attempts || 0) + 1;
            await otpSession.save();
            return res.status(400).json({ error: "Invalid OTP provided" });
        }

        await OtpSession.deleteOne({ _id: otpSession._id });

        // ── Duplicate prevention: Check for in-progress payout ───────────
        const inProgress = await EngagementPayout.findOne({ status: 'processing' });
        if (inProgress) {
            return res.status(409).json({ 
                error: "Another engagement payout is already in progress. Please wait for it to complete.",
                existingPayoutId: inProgress._id
            });
        }

        const now = new Date();
        const baseMonth = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const payoutRunId = `${baseMonth}_${now.getTime()}`;

        // ── Find period start from last successful payout ────────────────
        const lastPayout = await EngagementPayout.findOne({ 
            status: { $in: ['completed', 'partial'] } 
        }).sort({ createdAt: -1 });
        const periodStart = lastPayout ? lastPayout.periodEnd : new Date(0);
        const periodEnd = now;

        // ── Create payout record immediately with 'processing' status ────
        const payoutRecord = await EngagementPayout.create({
            payoutMonth: payoutRunId,
            status: 'processing',
            initiatedBy: req.admin?._id,
            periodStart,
            periodEnd,
            baseCpmUsed: BASE_CPM,
            growthFactorEnabled: true,
            minViewsThreshold: Math.max(minViews, MIN_VIEWS_FOR_PAYOUT),
        });

        console.log(`\n=================== [ENGAGEMENT_PAYOUT_INIT] ===================`);
        console.log(`PayoutID: ${payoutRecord._id} | Month: ${payoutRunId} | Min Views: ${minViews}`);

        // ── Fetch eligible content ───────────────────────────────────────
        const filterQuery = { 
            status: { $ne: 'removed' }, 
            contentType: { $in: ['video', 'audio', 'short'] }, 
            views: { $gte: Math.max(minViews, 1) } 
        };
        
        if (Array.isArray(selectedContentIds) && selectedContentIds.length > 0) {
            filterQuery._id = { $in: selectedContentIds.map(id => new mongoose.Types.ObjectId(id)) };
        } else if (Array.isArray(selectedCreatorIds) && selectedCreatorIds.length > 0) {
            filterQuery.userId = { $in: selectedCreatorIds.map(id => new mongoose.Types.ObjectId(id)) };
        }

        const allContent = await Content.find(filterQuery)
            .populate('userId', 'userName channelName channelBanned')
            .lean();
        
        // ── Batch-fetch engagement counts (eliminates N+1) ───────────────
        const contentIds = allContent.map(c => c._id);
        const { commentMap, shareMap } = await batchFetchEngagementCounts(contentIds);

        // ── Process each content item ────────────────────────────────────
        const contentPayouts = [];
        const skippedContents = [];
        let totalPool = 0;
        const payoutsByCreator = new Map();

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    contentType: content.contentType,
                    reason: 'Creator not found',
                    views: content.views || 0,
                });
                continue;
            }
            if (creator.channelBanned) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    contentType: content.contentType,
                    creatorId: creator._id,
                    creatorName: creator.channelName || creator.userName || 'Unknown',
                    reason: 'Creator channel is banned',
                    views: content.views || 0,
                });
                continue;
            }

            const comments = commentMap.get(content._id.toString()) || 0;
            const shares = shareMap.get(content._id.toString()) || (content.shareCount || 0);

            const calc = calculateContentPayout(content, comments, shares, BASE_CPM);

            if (calc.skip) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    contentType: content.contentType,
                    creatorId: creator._id,
                    creatorName: creator.channelName || creator.userName || 'Unknown',
                    reason: calc.reason,
                    views: content.views || 0,
                });
                continue;
            }

            if (calc.payoutAmount <= 0) continue;

            // Apply growth factor
            const growthFactor = computeGrowthFactor(content, periodStart);
            const adjustedPayout = Math.round(calc.payoutAmount * growthFactor * 100) / 100;

            totalPool += adjustedPayout;

            const item = {
                contentId: content._id,
                contentTitle: content.title || 'Untitled',
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                growthFactor,
                payoutAmount: adjustedPayout,
                deltaViews: calc.deltaViews,
                metrics: calc.metrics,
            };
            contentPayouts.push(item);

            const creatorKey = creator._id.toString();
            if (!payoutsByCreator.has(creatorKey)) {
                payoutsByCreator.set(creatorKey, {
                    creatorId: creator._id,
                    creatorName: creator.channelName || creator.userName || 'Unknown',
                    totalPayout: 0,
                    contents: [],
                });
            }
            const group = payoutsByCreator.get(creatorKey);
            group.totalPayout += adjustedPayout;
            group.contents.push(item);
        }

        console.log(`Evaluating ${allContent.length} content → ${contentPayouts.length} eligible, ${skippedContents.length} skipped`);

        // ── Execute transactions per creator ─────────────────────────────
        const failedContents = [];
        let creatorsProcessed = 0;

        for (const [creatorId, group] of payoutsByCreator.entries()) {
            const session = await mongoose.startSession();
            try {
                session.startTransaction();
                
                let wallet = await SecondaryWallet.findOne({ userId: creatorId }).session(session);
                if (!wallet) {
                    wallet = new SecondaryWallet({ userId: creatorId, balance: 0 });
                }

                wallet.balance += group.totalPayout;
                await wallet.save({ session });

                // Single aggregated transaction per creator
                const aggTxn = new WalletTransaction({
                    walletId: wallet._id,
                    walletType: 'secondary',
                    type: 'engagement_earning_credit',
                    amount: group.totalPayout,
                    balanceAfter: wallet.balance,
                    status: 'completed',
                    description: `Engagement Payout (${group.contents.length} content)`,
                    metadata: {
                        payoutRunId: payoutRecord._id,
                        contentCount: group.contents.length,
                        contentBreakdown: group.contents.map(item => ({
                            contentId: item.contentId,
                            contentTitle: item.contentTitle,
                            contentType: item.contentType,
                            payoutAmount: item.payoutAmount,
                            deltaViews: item.deltaViews,
                            engagementScore: item.engagementScore,
                            engagementMultiplier: item.engagementMultiplier,
                            growthFactor: item.growthFactor,
                            metrics: item.metrics,
                        }))
                    },
                    idempotencyKey: `eng_run_${payoutRunId}_${creatorId}`
                });
                await aggTxn.save({ session });

                // Update content: mark views as paid using lastEngagementPayoutViews
                for (const item of group.contents) {
                    await Content.updateOne(
                        { _id: item.contentId },
                        { 
                            $set: { 
                                lastEngagementPayoutViews: item.metrics.views,
                                lastPayoutAt: now 
                            } 
                        }
                    ).session(session);
                }
                
                await session.commitTransaction();
                creatorsProcessed++;

                // Fire-and-forget email notification (outside transaction)
                _sendCreatorPayoutEmail(creatorId, group, payoutRunId).catch(() => {});
            } catch (error) {
                console.error(`❌ Transaction failed for creator ${creatorId}:`, error);
                await session.abortTransaction();
                
                for (const item of group.contents) {
                    failedContents.push({
                        contentId: item.contentId,
                        contentTitle: item.contentTitle,
                        contentType: item.contentType,
                        creatorId: item.creatorId,
                        creatorName: item.creatorName,
                        amount: item.payoutAmount,
                        error: error.message,
                    });
                }
            } finally {
                session.endSession();
            }
        }

        // ── Update payout record with results ────────────────────────────
        const finalStatus = failedContents.length > 0 
            ? (creatorsProcessed > 0 ? 'partial' : 'failed') 
            : 'completed';

        await EngagementPayout.findByIdAndUpdate(payoutRecord._id, {
            $set: {
                status: finalStatus,
                totalPool,
                totalContentEvaluated: allContent.length,
                totalCreatorsPaid: creatorsProcessed,
                totalContentPaid: contentPayouts.length,
                totalContentSkipped: skippedContents.length,
                totalContentFailed: failedContents.length,
                contentPayouts,
                skippedContents,
                failedContents,
            }
        });

        console.log(`✅ [ENGAGEMENT_PAYOUT_${finalStatus.toUpperCase()}] Pool: ₹${totalPool.toFixed(2)} | Creators: ${creatorsProcessed} | Paid: ${contentPayouts.length} | Skipped: ${skippedContents.length} | Failed: ${failedContents.length}`);

        return res.json({
            success: true,
            message: `Engagement payout ${finalStatus}`,
            payoutId: payoutRecord._id,
            status: finalStatus,
            totalDistributed: totalPool,
            creatorsPaid: creatorsProcessed,
            contentEvaluated: allContent.length,
            contentPaid: contentPayouts.length,
            contentSkipped: skippedContents.length,
            contentFailed: failedContents.length,
            payoutMonth: payoutRunId,
        });

    } catch (error) {
        console.error('❌ Error running engagement payout:', error);
        return res.status(500).json({ error: 'Failed to run engagement payout' });
    }
};

// ─── PREVIEW ─────────────────────────────────────────────────────────────────

export const previewEngagementPayout = async (req, res) => {
    try {
        const { minViews: minViewsQuery, creatorId } = req.query;
        const minViews = minViewsQuery !== undefined ? parseInt(minViewsQuery) : MIN_VIEWS_FOR_PAYOUT;
        
        const query = { 
            status: { $ne: 'removed' }, 
            contentType: { $in: ['video', 'audio', 'short'] }, 
            views: { $gte: Math.max(minViews, 1) } 
        };
        if (creatorId && mongoose.Types.ObjectId.isValid(creatorId)) {
            query.userId = new mongoose.Types.ObjectId(creatorId);
        }

        const lastPayout = await EngagementPayout.findOne({ 
            status: { $in: ['completed', 'partial'] } 
        }).sort({ createdAt: -1 });
        const periodStart = lastPayout ? lastPayout.periodEnd : new Date(0);

        const allContent = await Content.find(query)
            .populate('userId', 'userName channelName channelBanned')
            .lean();
        
        // Batch-fetch engagement counts
        const contentIds = allContent.map(c => c._id);
        const { commentMap, shareMap } = await batchFetchEngagementCounts(contentIds);

        const contentPayouts = [];
        const skippedContents = [];
        let totalPool = 0;
        const totalCreators = new Set();

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator || creator.channelBanned) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    creatorName: creator ? (creator.channelName || creator.userName || 'Unknown') : 'Unknown',
                    reason: !creator ? 'Creator not found' : 'Channel banned',
                    views: content.views || 0,
                });
                continue;
            }

            const comments = commentMap.get(content._id.toString()) || 0;
            const shares = shareMap.get(content._id.toString()) || (content.shareCount || 0);
            const calc = calculateContentPayout(content, comments, shares, BASE_CPM);

            if (calc.skip) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    creatorName: creator.channelName || creator.userName || 'Unknown',
                    reason: calc.reason,
                    views: content.views || 0,
                });
                continue;
            }

            if (calc.payoutAmount <= 0) continue;

            const growthFactor = computeGrowthFactor(content, periodStart);
            const adjustedPayout = Math.round(calc.payoutAmount * growthFactor * 100) / 100;

            totalPool += adjustedPayout;
            totalCreators.add(creator._id.toString());

            contentPayouts.push({
                contentId: content._id,
                contentTitle: content.title || 'Untitled',
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                growthFactor,
                payoutAmount: adjustedPayout,
                deltaViews: calc.deltaViews,
                metrics: calc.metrics,
            });
        }

        return res.json({
            success: true,
            totalContent: contentPayouts.length,
            totalProjectedPayout: totalPool,
            totalCreators: totalCreators.size,
            totalSkipped: skippedContents.length,
            minViewsThreshold: minViews,
            baseCpm: BASE_CPM,
            contentBreakdown: contentPayouts,
            skippedBreakdown: skippedContents,
        });

    } catch (error) {
        console.error('❌ Error previewing engagement payout:', error);
        return res.status(500).json({ error: 'Failed to preview engagement payout' });
    }
};

// ─── REPORT ──────────────────────────────────────────────────────────────────

export const getEngagementPayoutReport = async (req, res) => {
    try {
        const { month } = req.params;
        let filter = {};
        if (month && month !== 'all') {
            filter.payoutMonth = { $regex: new RegExp(`^${month}`) };
        }
        const payouts = await EngagementPayout.find(filter)
            .sort({ createdAt: -1 })
            .lean();
        
        return res.json({ success: true, payouts });
    } catch (error) {
        console.error('❌ Error getting engagement payout report:', error);
        return res.status(500).json({ error: 'Failed to fetch report' });
    }
};

// ─── DETAILED TRANSACTION DRILLDOWN ──────────────────────────────────────────

export const getEngagementPayoutDetail = async (req, res) => {
    try {
        const { payoutId } = req.params;
        const payout = await EngagementPayout.findById(payoutId).lean();
        if (!payout) {
            return res.status(404).json({ error: 'Engagement payout record not found' });
        }

        // Group content payouts by creator
        const creatorMap = new Map();
        for (const cp of (payout.contentPayouts || [])) {
            const key = cp.creatorId?.toString() || 'unknown';
            if (!creatorMap.has(key)) {
                creatorMap.set(key, {
                    creatorId: cp.creatorId,
                    creatorName: cp.creatorName,
                    totalPayout: 0,
                    contentCount: 0,
                    contents: [],
                });
            }
            const group = creatorMap.get(key);
            group.totalPayout += cp.payoutAmount;
            group.contentCount++;
            group.contents.push(cp);
        }

        return res.json({
            success: true,
            payout: {
                _id: payout._id,
                payoutMonth: payout.payoutMonth,
                status: payout.status,
                totalPool: payout.totalPool,
                totalContentEvaluated: payout.totalContentEvaluated,
                totalCreatorsPaid: payout.totalCreatorsPaid,
                totalContentPaid: payout.totalContentPaid,
                totalContentSkipped: payout.totalContentSkipped,
                totalContentFailed: payout.totalContentFailed,
                baseCpmUsed: payout.baseCpmUsed,
                growthFactorEnabled: payout.growthFactorEnabled,
                periodStart: payout.periodStart,
                periodEnd: payout.periodEnd,
                createdAt: payout.createdAt,
                initiatedBy: payout.initiatedBy,
            },
            creators: Array.from(creatorMap.values()).sort((a, b) => b.totalPayout - a.totalPayout),
            skipped: payout.skippedContents || [],
            failed: payout.failedContents || [],
        });
    } catch (error) {
        console.error('❌ Error fetching engagement payout detail:', error);
        return res.status(500).json({ error: 'Failed to fetch payout detail' });
    }
};

// ─── SINGLE CREATOR ENGAGEMENT PAYOUT ────────────────────────────────────────

export const runSingleCreatorEngagementPayout = async (req, res) => {
    try {
        const { userId, minViews = MIN_VIEWS_FOR_PAYOUT } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        // Duplicate prevention
        const inProgress = await EngagementPayout.findOne({ status: 'processing' });
        if (inProgress) {
            return res.status(409).json({ 
                error: "Another engagement payout is already in progress.",
                existingPayoutId: inProgress._id
            });
        }

        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}_single_${userId}_${now.getTime()}`;

        const creatorUser = await User.findById(userId).lean();
        if (!creatorUser || creatorUser.channelBanned) {
            return res.status(400).json({ error: "Creator not found or banned" });
        }

        const lastPayout = await EngagementPayout.findOne({ 
            status: { $in: ['completed', 'partial'] } 
        }).sort({ createdAt: -1 });
        const periodStart = lastPayout ? lastPayout.periodEnd : new Date(0);

        const allContent = await Content.find({ 
            userId, 
            status: { $ne: 'removed' }, 
            contentType: { $in: ['video', 'audio', 'short'] }, 
            views: { $gte: Math.max(minViews, 1) } 
        }).lean();

        // Batch-fetch engagement
        const contentIds = allContent.map(c => c._id);
        const { commentMap, shareMap } = await batchFetchEngagementCounts(contentIds);
        
        const contentPayouts = [];
        const skippedContents = [];
        let totalPayout = 0;

        for (const content of allContent) {
            const comments = commentMap.get(content._id.toString()) || 0;
            const shares = shareMap.get(content._id.toString()) || (content.shareCount || 0);
            const calc = calculateContentPayout(content, comments, shares, BASE_CPM);

            if (calc.skip) {
                skippedContents.push({
                    contentId: content._id,
                    contentTitle: content.title || 'Untitled',
                    contentType: content.contentType,
                    creatorId: userId,
                    creatorName: creatorUser.channelName || creatorUser.userName || 'Unknown',
                    reason: calc.reason,
                    views: content.views || 0,
                });
                continue;
            }

            if (calc.payoutAmount <= 0) continue;

            const growthFactor = computeGrowthFactor(content, periodStart);
            const adjustedPayout = Math.round(calc.payoutAmount * growthFactor * 100) / 100;
            totalPayout += adjustedPayout;

            contentPayouts.push({
                contentId: content._id,
                contentTitle: content.title || 'Untitled',
                contentType: content.contentType,
                creatorId: creatorUser._id,
                creatorName: creatorUser.channelName || creatorUser.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                growthFactor,
                payoutAmount: adjustedPayout,
                deltaViews: calc.deltaViews,
                metrics: calc.metrics,
            });
        }

        if (totalPayout <= 0) {
            return res.json({ 
                success: true, 
                message: "No eligible payouts for this creator", 
                data: { totalPayout: 0, skipped: skippedContents } 
            });
        }

        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            
            let wallet = await SecondaryWallet.findOne({ userId }).session(session);
            if (!wallet) {
                wallet = new SecondaryWallet({ userId, balance: 0 });
            }

            wallet.balance += totalPayout;
            await wallet.save({ session });

            const aggTxn = new WalletTransaction({
                walletId: wallet._id,
                walletType: 'secondary',
                type: 'engagement_earning_credit',
                amount: totalPayout,
                balanceAfter: wallet.balance,
                status: 'completed',
                description: `Engagement Payout (${contentPayouts.length} content)`,
                metadata: {
                    contentCount: contentPayouts.length,
                    contentBreakdown: contentPayouts.map(item => ({
                        contentId: item.contentId,
                        contentTitle: item.contentTitle,
                        contentType: item.contentType,
                        payoutAmount: item.payoutAmount,
                        deltaViews: item.deltaViews,
                        engagementScore: item.engagementScore,
                        engagementMultiplier: item.engagementMultiplier,
                        growthFactor: item.growthFactor,
                        metrics: item.metrics,
                    }))
                },
                idempotencyKey: `eng_single_${month}_${userId}`
            });
            await aggTxn.save({ session });

            for (const item of contentPayouts) {
                await Content.updateOne(
                    { _id: item.contentId },
                    { $set: { lastEngagementPayoutViews: item.metrics.views, lastPayoutAt: now } }
                ).session(session);
            }
            
            await session.commitTransaction();

            // Fire-and-forget email
            _sendCreatorPayoutEmail(userId, { totalPayout, contents: contentPayouts }, month).catch(() => {});
        } catch (error) {
            console.error(`❌ Transaction failed for creator ${userId}:`, error);
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }

        const record = await EngagementPayout.create({
            payoutMonth: month,
            totalPool: totalPayout,
            totalContentEvaluated: allContent.length,
            totalCreatorsPaid: 1,
            totalContentPaid: contentPayouts.length,
            totalContentSkipped: skippedContents.length,
            contentPayouts,
            skippedContents,
            periodStart,
            periodEnd: now,
            initiatedBy: req.admin?._id,
            status: 'completed',
            baseCpmUsed: BASE_CPM,
            growthFactorEnabled: true,
        });

        return res.json({
            success: true,
            message: `Single creator engagement payout completed`,
            payoutId: record._id,
            data: {
                totalPool: record.totalPool,
                totalContentPaid: record.totalContentPaid,
                totalContentSkipped: skippedContents.length,
                skipped: skippedContents,
            }
        });

    } catch (error) {
        console.error('❌ Error running single creator payout:', error);
        return res.status(500).json({ error: 'Failed to run single creator payout' });
    }
};

// ─── Internal Helper ─────────────────────────────────────────────────────────

async function _sendCreatorPayoutEmail(creatorId, group, payoutMonth) {
    try {
        const creatorUser = await User.findById(creatorId).select('email contact userName channelName').lean();
        const recipientEmail = creatorUser?.email || (creatorUser?.contact && creatorUser.contact.includes('@') ? creatorUser.contact : null);
        if (recipientEmail) {
            await sendAdminEmail('engagementPayoutCredited', recipientEmail, {
                creatorName: creatorUser.channelName || creatorUser.userName || 'Creator',
                totalAmount: group.totalPayout,
                contentCount: group.contents.length,
                payoutMonth,
                contentBreakdown: group.contents
            });
        }
    } catch (emailErr) {
        console.error(`⚠️ Failed to send engagement payout email to creator ${creatorId}:`, emailErr.message);
    }
}
