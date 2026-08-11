import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Comment from '../../models/comment.model.js';
import EngagementPayout from '../../models/engagementPayout.model.js';
import OtpSession from '../../models/adminOtpSession.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { sendOtpToPhone } from '../auth-controllers/services/otpServicePhone.js';
import { sendAdminEmail } from '../../services/adminEmailService.js';
import crypto from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_CPM = 0.13;        // ₹0.13/view = ₹130/1K views (floor)
const MAX_CPM  = 0.175;       // ₹0.175/view = ₹175/1K views (ceiling)
const CPM_BOOST = MAX_CPM - BASE_CPM; // ₹0.045 available to earn via engagement
const MIN_NEW_VIEWS = 5;      // must have at least 5 new views to be eligible

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

/**
 * Compute a normalised 0-1 Engagement Quality Score (EQS) from content metrics.
 *
 * Weights (must sum to 1.0):
 *   Watch-time completion  35% — most important signal of genuine viewership
 *   Completion rate        25% — how many viewers finish the content
 *   Like rate              15% — active positive engagement
 *   Comment rate           10% — high-effort engagement
 *   Freshness factor       10% — proportion of views that are new (growth signal)
 *   Share rate              5% — viral distribution
 */
function computeEqs(metrics) {
    const { views, newViews, avgWatchPercent, completionRate, likes, comments, shares } = metrics;
    const safeViews = Math.max(views, 1);

    // Watch-time: 65% avg watch = perfect score
    const watchScore = clamp(avgWatchPercent / 65, 0, 1);

    // Completion: 55% full completion = perfect score
    const completionScore = clamp(completionRate / 55, 0, 1);

    // Like rate: 5% like-to-view ratio = perfect (anti-spam capped)
    const rawLikeRate = likes / safeViews;
    const likeScore = clamp(rawLikeRate / 0.05, 0, 1);

    // Comment rate: 2% comment-to-view = perfect
    const commentScore = clamp((comments / safeViews) / 0.02, 0, 1);

    // Freshness: what fraction of total views are "new" (since last payout)
    const freshnessScore = clamp(newViews / safeViews, 0, 1);

    // Share rate: 1% share-to-view = perfect
    const shareScore = clamp((shares / safeViews) / 0.01, 0, 1);

    const eqs =
        watchScore      * 0.35 +
        completionScore * 0.25 +
        likeScore       * 0.15 +
        commentScore    * 0.10 +
        freshnessScore  * 0.10 +
        shareScore      * 0.05;

    return clamp(eqs, 0, 1);
}

/**
 * Compute payout for a single content item.
 * Uses newViews (views since last payout) to prevent double-paying old data.
 * Returns null if not eligible.
 */
function computeContentPayout(content, commentCount) {
    const totalViews = content.views || 0;
    const paidViews  = content.paidViews || 0;
    const newViews   = Math.max(totalViews - paidViews, 0);

    if (newViews < MIN_NEW_VIEWS) return null;

    const metrics = {
        views: totalViews,
        newViews,
        paidViews,
        avgWatchPercent: content.averageWatchPercent || 0,
        completionRate:  content.completionRate || 0,
        likes:    content.likeCount || 0,
        dislikes: content.dislikeCount || 0,
        comments: commentCount,
        shares:   content.shareCount || 0,
        totalWatchTime: content.totalWatchTime || 0,
        duration: content.duration || 0,
    };

    const eqs = computeEqs(metrics);
    const effectiveCpm = BASE_CPM + eqs * CPM_BOOST;

    // Growth factor: bonus for content with rapidly growing views
    let growthFactor = 1.0;
    if (totalViews > 0) {
        const newViewRatio = newViews / totalViews;
        if (newViewRatio >= 0.60) growthFactor = 1.10;      // 60%+ new views = viral
        else if (newViewRatio >= 0.30) growthFactor = 1.05; // 30%+ = growing
    }

    const payoutAmount = newViews * effectiveCpm * growthFactor;

    return {
        newViews,
        paidViews,
        totalViews,
        eqs: Math.round(eqs * 100),        // 0-100 score
        engagementMultiplier: effectiveCpm / BASE_CPM, // e.g. 1.0x – 1.35x
        effectiveCpm,
        growthFactor,
        payoutAmount,
        metrics,
    };
}

// ─── Batch fetch comment counts (eliminates N+1 queries) ────────────────────
async function batchCommentCounts(contentIds) {
    if (!contentIds.length) return {};
    const results = await Comment.aggregate([
        { $match: { videoId: { $in: contentIds } } },
        { $group: { _id: '$videoId', count: { $sum: 1 } } },
    ]);
    const map = {};
    for (const r of results) {
        map[r._id.toString()] = r.count;
    }
    return map;
}

// ─── OTP: Send engagement payout OTP ────────────────────────────────────────
export const sendEngagementPayoutOtp = async (req, res) => {
    try {
        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: 'Admin authentication required or contact details missing' });
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
            expires_at: new Date(Date.now() + 5 * 60 * 1000),
        });

        let sent = false;
        try {
            if (channel === 'email') {
                sent = await sendOtpToEmail(contact, otp, 'engagement_payout');
            } else {
                sent = await sendOtpToPhone(contact, otp);
            }
        } catch (emailErr) {
            console.error('⚠️ OTP dispatch error:', emailErr.message);
        }

        console.log(`\n=================== [ADMIN_ENGAGEMENT_OTP] ===================`);
        console.log(`🔑 OTP for Admin (${contact}): [ ${otp} ]`);
        console.log(`==============================================================\n`);

        return res.json({
            success: true,
            message: sent
                ? `OTP sent successfully to admin contact (${contact})`
                : `OTP generated for admin (${contact}): ${otp}`,
        });
    } catch (error) {
        console.error('❌ Error sending engagement payout OTP:', error);
        return res.status(500).json({ error: 'Failed to send OTP' });
    }
};

// ─── Preview: estimate payout without executing ──────────────────────────────
export const previewEngagementPayout = async (req, res) => {
    try {
        const { minViews: minViewsQuery, creatorId } = req.query;
        const minViews = minViewsQuery !== undefined ? parseInt(minViewsQuery, 10) : 0;

        const query = {
            status: { $ne: 'removed' },
            contentType: { $in: ['video', 'audio'] },
            views: { $gt: minViews },
        };
        if (creatorId && mongoose.Types.ObjectId.isValid(creatorId)) {
            query.userId = new mongoose.Types.ObjectId(creatorId);
        }

        const allContent = await Content.find(query)
            .populate('userId', 'userName channelName channelBanned')
            .lean();

        // Batch comment counts — single DB round-trip
        const contentIds = allContent.map(c => c._id);
        const commentMap = await batchCommentCounts(contentIds);

        const contentBreakdown = [];
        let totalPool = 0;
        const creatorSet = new Set();
        const skipped = [];

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator || creator.channelBanned) {
                skipped.push({ contentId: content._id, reason: 'creator_banned' });
                continue;
            }

            const commentCount = commentMap[content._id.toString()] || 0;
            const calc = computeContentPayout(content, commentCount);
            if (!calc) {
                skipped.push({ contentId: content._id, contentTitle: content.title, reason: `new_views < ${MIN_NEW_VIEWS}` });
                continue;
            }

            totalPool += calc.payoutAmount;
            creatorSet.add(creator._id.toString());

            contentBreakdown.push({
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                views: calc.totalViews,
                newViews: calc.newViews,
                paidViews: calc.paidViews,
                eqs: calc.eqs,
                engagementMultiplier: parseFloat(calc.engagementMultiplier.toFixed(4)),
                effectiveCpm: parseFloat(calc.effectiveCpm.toFixed(6)),
                growthFactor: calc.growthFactor,
                payoutAmount: parseFloat(calc.payoutAmount.toFixed(4)),
                metrics: calc.metrics,
            });
        }

        return res.json({
            success: true,
            totalContent: contentBreakdown.length,
            totalProjectedPayout: totalPool,
            totalCreators: creatorSet.size,
            minViewsThreshold: minViews,
            baseCpmPerView: BASE_CPM,
            maxCpmPerView: MAX_CPM,
            formula: `₹${BASE_CPM * 1000}–₹${MAX_CPM * 1000}/1K new views, based on EQS (watch time, completion, likes, comments, freshness, shares)`,
            skippedCount: skipped.length,
            contentBreakdown,
        });
    } catch (error) {
        console.error('❌ Error previewing engagement payout:', error);
        return res.status(500).json({ error: 'Failed to preview engagement payout' });
    }
};

// ─── Bulk run: execute payout for all eligible creators ─────────────────────
export const runEngagementPayout = async (req, res) => {
    try {
        const { otp, minViews = 0, selectedContentIds, selectedCreatorIds } = req.body;

        if (!otp) {
            return res.status(400).json({ error: 'Admin OTP is required to initiate engagement payout' });
        }

        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: 'Admin contact details missing' });
        }

        const otpSession = await OtpSession.findOne({
            contact,
            purpose: 'engagement_payout',
            expires_at: { $gt: new Date() },
        });
        if (!otpSession) {
            return res.status(400).json({ error: 'OTP expired or not requested. Please request a new OTP.' });
        }

        const otpHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
        if (otpSession.otp_hash !== otpHash) {
            otpSession.attempts = (otpSession.attempts || 0) + 1;
            await otpSession.save();
            return res.status(400).json({ error: 'Invalid OTP provided' });
        }
        await OtpSession.deleteOne({ _id: otpSession._id });

        const now = new Date();
        const runId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}_bulk_${now.getTime()}`;

        const isSelective =
            (Array.isArray(selectedContentIds) && selectedContentIds.length > 0) ||
            (Array.isArray(selectedCreatorIds) && selectedCreatorIds.length > 0);

        console.log(`\n=================== [ENGAGEMENT_PAYOUT_INIT] ===================`);
        console.log(`Run ID: ${runId}, Min Views: ${minViews}, Selective: ${isSelective}`);

        const filterQuery = {
            status: { $ne: 'removed' },
            contentType: { $in: ['video', 'audio'] },
            views: { $gt: Math.max(minViews, 0) },
        };
        if (Array.isArray(selectedContentIds) && selectedContentIds.length > 0) {
            filterQuery._id = { $in: selectedContentIds.map(id => new mongoose.Types.ObjectId(id)) };
        } else if (Array.isArray(selectedCreatorIds) && selectedCreatorIds.length > 0) {
            filterQuery.userId = { $in: selectedCreatorIds.map(id => new mongoose.Types.ObjectId(id)) };
        }

        const allContent = await Content.find(filterQuery)
            .populate('userId', 'userName channelName channelBanned')
            .lean();

        // Batch comment counts — single round-trip
        const contentIds = allContent.map(c => c._id);
        const commentMap = await batchCommentCounts(contentIds);

        const payoutsByCreator = new Map();
        const allContentPayouts = [];
        let totalPool = 0;
        const skippedItems = [];

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator || creator.channelBanned) {
                skippedItems.push({ contentId: content._id, reason: 'creator_banned' });
                continue;
            }

            const commentCount = commentMap[content._id.toString()] || 0;
            const calc = computeContentPayout(content, commentCount);
            if (!calc) {
                skippedItems.push({ contentId: content._id, contentTitle: content.title, reason: `new_views < ${MIN_NEW_VIEWS}` });
                continue;
            }

            totalPool += calc.payoutAmount;

            const item = {
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                engagementScore: calc.eqs,
                engagementMultiplier: calc.engagementMultiplier,
                payoutAmount: calc.payoutAmount,
                metrics: calc.metrics,
            };
            allContentPayouts.push(item);

            const key = creator._id.toString();
            if (!payoutsByCreator.has(key)) {
                payoutsByCreator.set(key, { creatorId: creator._id, totalPayout: 0, contents: [] });
            }
            const group = payoutsByCreator.get(key);
            group.totalPayout += calc.payoutAmount;
            group.contents.push(item);
        }

        console.log(`📊 Eligible: ${allContentPayouts.length} items across ${payoutsByCreator.size} creators. Skipped: ${skippedItems.length}`);

        // Execute per-creator transactions
        const txErrors = [];
        for (const [creatorId, group] of payoutsByCreator.entries()) {
            const idempotencyKey = `eng_run_${runId}_${creatorId}`;
            const existing = await WalletTransaction.findOne({ idempotencyKey }).lean();
            if (existing) {
                console.warn(`⚠️ Duplicate payout skipped for creator ${creatorId}`);
                continue;
            }

            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                let wallet = await SecondaryWallet.findOne({ userId: creatorId }).session(session);
                if (!wallet) {
                    wallet = new SecondaryWallet({ userId: creatorId, balance: 0, status: 'active' });
                }
                wallet.balance += group.totalPayout;
                await wallet.save({ session });

                const aggTxn = new WalletTransaction({
                    walletId: wallet._id,
                    walletType: 'secondary',
                    type: 'engagement_earning_credit',
                    amount: group.totalPayout,
                    balanceAfter: wallet.balance,
                    status: 'completed',
                    description: `Engagement Earnings (${group.contents.length} content item${group.contents.length > 1 ? 's' : ''})`,
                    metadata: {
                        contentCount: group.contents.length,
                        contentBreakdown: group.contents.map(item => ({
                            contentId: item.contentId,
                            contentTitle: item.contentTitle,
                            contentType: item.contentType,
                            payoutAmount: item.payoutAmount,
                            engagementScore: item.engagementScore,
                            engagementMultiplier: item.engagementMultiplier,
                            metrics: item.metrics,
                        })),
                    },
                    idempotencyKey,
                });
                await aggTxn.save({ session });

                // Mark content views as paid to prevent re-payment
                for (const item of group.contents) {
                    await Content.updateOne(
                        { _id: item.contentId },
                        { $set: { paidViews: item.metrics.totalViews, lastPayoutAt: new Date() } },
                    ).session(session);
                }

                await session.commitTransaction();

                // Fire-and-forget email
                (async () => {
                    try {
                        const creatorUser = await User.findById(creatorId).select('email contact userName channelName').lean();
                        const recipientEmail = creatorUser?.email || (creatorUser?.contact?.includes('@') ? creatorUser.contact : null);
                        if (recipientEmail) {
                            await sendAdminEmail('engagementPayoutCredited', recipientEmail, {
                                creatorName: creatorUser.channelName || creatorUser.userName || 'Creator',
                                totalAmount: group.totalPayout,
                                contentCount: group.contents.length,
                                payoutMonth: runId,
                                contentBreakdown: group.contents,
                            });
                        }
                    } catch (emailErr) {
                        console.error(`⚠️ Engagement payout email failed for ${creatorId}:`, emailErr.message);
                    }
                })();
            } catch (error) {
                console.error(`❌ Transaction failed for creator ${creatorId}:`, error);
                txErrors.push({ creatorId, error: error.message });
                await session.abortTransaction();
            } finally {
                session.endSession();
            }
        }

        // Save payout record
        const record = await EngagementPayout.create({
            payoutMonth: runId,
            totalPool,
            totalContentEvaluated: allContent.length,
            totalCreatorsPaid: payoutsByCreator.size - txErrors.length,
            totalContentPaid: allContentPayouts.length,
            minViewsThreshold: minViews,
            contentPayouts: allContentPayouts,
            periodStart: new Date(0),
            periodEnd: now,
            initiatedBy: req.admin?._id,
            status: txErrors.length > 0 ? 'partial' : 'completed',
        });

        console.log(`✅ [ENGAGEMENT_PAYOUT_SUCCESS] Pool: ₹${totalPool.toFixed(2)}, Creators: ${payoutsByCreator.size}, Errors: ${txErrors.length}`);

        return res.json({
            success: true,
            message: `Engagement payout ${txErrors.length > 0 ? 'partially' : 'fully'} completed`,
            totalDistributed: totalPool,
            creatorsPaid: payoutsByCreator.size - txErrors.length,
            contentEvaluated: allContent.length,
            contentPaid: allContentPayouts.length,
            skipped: skippedItems.length,
            errors: txErrors,
            payoutMonth: record.payoutMonth,
            baseCpmPerView: BASE_CPM,
            maxCpmPerView: MAX_CPM,
        });
    } catch (error) {
        console.error('❌ Error running engagement payout:', error);
        return res.status(500).json({ error: 'Failed to run engagement payout' });
    }
};

// ─── Single creator payout (SuperAdmin) ─────────────────────────────────────
export const runSingleCreatorEngagementPayout = async (req, res) => {
    try {
        const { userId, minViews = 0 } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const now = new Date();
        const runId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}_single_${userId}_${now.getTime()}`;

        const creatorUser = await User.findById(userId).lean();
        if (!creatorUser || creatorUser.channelBanned) {
            return res.status(400).json({ error: 'Creator not found or banned' });
        }

        const allContent = await Content.find({
            userId,
            status: { $ne: 'removed' },
            contentType: { $in: ['video', 'audio'] },
            views: { $gt: Math.max(minViews, 0) },
        }).lean();

        // Batch comment counts
        const contentIds = allContent.map(c => c._id);
        const commentMap = await batchCommentCounts(contentIds);

        const contentPayouts = [];
        const skippedItems = [];
        let totalPayout = 0;

        for (const content of allContent) {
            const commentCount = commentMap[content._id.toString()] || 0;
            const calc = computeContentPayout(content, commentCount);
            if (!calc) {
                skippedItems.push({ contentId: content._id, contentTitle: content.title, reason: `new_views < ${MIN_NEW_VIEWS}` });
                continue;
            }

            totalPayout += calc.payoutAmount;
            contentPayouts.push({
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creatorUser._id,
                creatorName: creatorUser.channelName || creatorUser.userName || 'Unknown',
                engagementScore: calc.eqs,
                engagementMultiplier: calc.engagementMultiplier,
                payoutAmount: calc.payoutAmount,
                metrics: calc.metrics,
            });
        }

        if (totalPayout <= 0 || contentPayouts.length === 0) {
            return res.json({
                success: true,
                message: `No eligible payouts for this creator (all content has < ${MIN_NEW_VIEWS} new views since last payout)`,
                data: { totalPayout: 0, contentPaid: 0, skipped: skippedItems.length },
            });
        }

        // Idempotency: prevent duplicate run within the same minute
        const idempotencyKey = `eng_single_${runId}_${userId}`;
        const existing = await WalletTransaction.findOne({ idempotencyKey }).lean();
        if (existing) {
            return res.status(409).json({ error: 'Duplicate payout: a payout was already processed for this run.' });
        }

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            let wallet = await SecondaryWallet.findOne({ userId }).session(session);
            if (!wallet) {
                wallet = new SecondaryWallet({ userId, balance: 0, status: 'active' });
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
                description: `Engagement Earnings (${contentPayouts.length} item${contentPayouts.length > 1 ? 's' : ''})`,
                metadata: {
                    contentCount: contentPayouts.length,
                    contentBreakdown: contentPayouts.map(item => ({
                        contentId: item.contentId,
                        contentTitle: item.contentTitle,
                        contentType: item.contentType,
                        payoutAmount: item.payoutAmount,
                        engagementScore: item.engagementScore,
                        engagementMultiplier: item.engagementMultiplier,
                        metrics: item.metrics,
                    })),
                },
                idempotencyKey,
            });
            await aggTxn.save({ session });

            // Mark content as paid
            for (const item of contentPayouts) {
                await Content.updateOne(
                    { _id: item.contentId },
                    { $set: { paidViews: item.metrics.totalViews, lastPayoutAt: new Date() } },
                ).session(session);
            }

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }

        // Save record
        const record = await EngagementPayout.create({
            payoutMonth: runId,
            totalPool: totalPayout,
            totalContentEvaluated: allContent.length,
            totalCreatorsPaid: 1,
            totalContentPaid: contentPayouts.length,
            minViewsThreshold: minViews,
            contentPayouts,
            periodStart: new Date(0),
            periodEnd: now,
            initiatedBy: req.admin?._id,
            status: 'completed',
        });

        // Fire-and-forget email
        (async () => {
            try {
                const recipientEmail = creatorUser?.email || (creatorUser?.contact?.includes('@') ? creatorUser.contact : null);
                if (recipientEmail) {
                    await sendAdminEmail('engagementPayoutCredited', recipientEmail, {
                        creatorName: creatorUser.channelName || creatorUser.userName || 'Creator',
                        totalAmount: totalPayout,
                        contentCount: contentPayouts.length,
                        payoutMonth: runId,
                        contentBreakdown: contentPayouts,
                    });
                }
            } catch (emailErr) {
                console.error(`⚠️ Single engagement payout email failed for ${userId}:`, emailErr.message);
            }
        })();

        console.log(`✅ [SINGLE_ENG_PAYOUT] Creator: ${userId}, Amount: ₹${totalPayout.toFixed(2)}, Items: ${contentPayouts.length}`);

        return res.json({
            success: true,
            message: `Engagement payout of ₹${totalPayout.toFixed(2)} credited to Secondary Wallet`,
            data: {
                totalPool: record.totalPool,
                totalContentPaid: record.totalContentPaid,
                skipped: skippedItems.length,
                baseCpmPerView: BASE_CPM,
                maxCpmPerView: MAX_CPM,
            },
        });
    } catch (error) {
        console.error('❌ Error running single creator payout:', error);
        return res.status(500).json({ error: 'Failed to run single creator payout' });
    }
};

// ─── Report: get payout history by month prefix ──────────────────────────────
export const getEngagementPayoutReport = async (req, res) => {
    try {
        const { month } = req.params;
        const regex = new RegExp(`^${month}`);
        const payouts = await EngagementPayout.find({ payoutMonth: regex })
            .sort({ createdAt: -1 })
            .lean();
        return res.json({ success: true, payouts });
    } catch (error) {
        console.error('❌ Error getting engagement payout report:', error);
        return res.status(500).json({ error: 'Failed to fetch report' });
    }
};
