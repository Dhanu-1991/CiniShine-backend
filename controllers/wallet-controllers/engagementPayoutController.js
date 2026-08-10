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

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

function mapRange(val, inMin, inMax, outMin, outMax) {
    return outMin + ((clamp(val, inMin, inMax) - inMin) / (inMax - inMin)) * (outMax - outMin);
}

// Helper to compute engagement metrics and payout for a single content
async function calculateContentPayout(content, baseCpm = 0.25) {
    const views = content.views || 0;
    const avgWatchPctMultiplier = mapRange(content.averageWatchPercent || 0, 0, 100, 0.5, 1.5);
    const completionMultiplier = mapRange(content.completionRate || 0, 0, 100, 0.5, 1.5);
    
    const likes = content.likeCount || 0;
    // Enhanced Like Rate: Likes relative to total views (capped at 10% like-to-view ratio)
    const likeRate = Math.min(likes / Math.max(views, 1), 0.1) / 0.1;
    const likeMultiplier = mapRange(likeRate, 0, 1, 0.8, 1.3);
    
    const comments = await Comment.countDocuments({ videoId: content._id });
    const commentRate = Math.min(comments / Math.max(views, 1), 0.1) / 0.1;
    const commentMultiplier = mapRange(commentRate, 0, 1, 0.9, 1.2);
    
    const shares = content.shareCount || 0;
    const shareRate = Math.min(shares / Math.max(views, 1), 0.05) / 0.05;
    const shareMultiplier = mapRange(shareRate, 0, 1, 0.9, 1.2);

    const engagementMultiplier = avgWatchPctMultiplier * 0.35 
                               + completionMultiplier * 0.25 
                               + likeMultiplier * 0.15 
                               + commentMultiplier * 0.15 
                               + shareMultiplier * 0.10;

    const payoutAmount = views * baseCpm * engagementMultiplier;

    return {
        engagementScore: engagementMultiplier * 100, // as a percentage roughly
        engagementMultiplier,
        payoutAmount,
        metrics: {
            views,
            totalWatchTime: content.totalWatchTime || 0,
            avgWatchPercent: content.averageWatchPercent || 0,
            completionRate: content.completionRate || 0,
            likes,
            dislikes: content.dislikeCount || 0,
            shares,
            comments
        }
    };
}

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
        if (channel === 'email') {
            sent = await sendOtpToEmail(contact, otp, 'engagement_payout');
        } else {
            sent = await sendOtpToPhone(contact, otp);
        }

        if (!sent) {
            return res.status(500).json({ error: "Failed to send OTP to admin contact" });
        }

        return res.json({
            success: true,
            message: `OTP sent successfully to admin contact (${contact})`
        });
    } catch (error) {
        console.error('❌ Error sending engagement payout OTP:', error);
        return res.status(500).json({ error: 'Failed to send OTP' });
    }
};

export const runEngagementPayout = async (req, res) => {
    try {
        const { otp, minViews = 0, selectedContentIds, selectedCreatorIds } = req.body;
        
        if (!otp) {
            return res.status(400).json({ error: "Admin OTP is required to initiate engagement payout" });
        }

        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: "Admin contact details missing" });
        }

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

        // OTP verified — clear session
        await OtpSession.deleteOne({ _id: otpSession._id });

        const now = new Date();
        const month = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Check if already run for this month (unless selective run)
        const isSelective = (Array.isArray(selectedContentIds) && selectedContentIds.length > 0) || (Array.isArray(selectedCreatorIds) && selectedCreatorIds.length > 0);
        if (!isSelective) {
            const existing = await EngagementPayout.findOne({ payoutMonth: month });
            if (existing && existing.status === 'completed') {
                return res.status(400).json({ error: `Engagement payout already completed for month ${month}` });
            }
        }

        // Find periodStart from the last successful run
        const lastPayout = await EngagementPayout.findOne({ status: 'completed' }).sort({ createdAt: -1 });
        const periodStart = lastPayout ? lastPayout.createdAt : new Date(0);
        const periodEnd = now;

        console.log(`\n=================== [ENGAGEMENT_PAYOUT_INIT] ===================`);
        console.log(`Month: ${month}, Min Views: ${minViews}, Selective: ${isSelective}`);

        const filterQuery = { status: { $ne: 'removed' }, views: { $gte: Math.max(minViews, 1) } };
        if (Array.isArray(selectedContentIds) && selectedContentIds.length > 0) {
            filterQuery._id = { $in: selectedContentIds.map(id => new mongoose.Types.ObjectId(id)) };
        } else if (Array.isArray(selectedCreatorIds) && selectedCreatorIds.length > 0) {
            filterQuery.userId = { $in: selectedCreatorIds.map(id => new mongoose.Types.ObjectId(id)) };
        }

        const allContent = await Content.find(filterQuery).populate('userId', 'userName channelName channelBanned').lean();
        
        const contentPayouts = [];
        let totalPool = 0;
        const payoutsByCreator = new Map();

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator || creator.channelBanned) continue;

            const calc = await calculateContentPayout(content);
            if (calc.payoutAmount <= 0) continue;

            totalPool += calc.payoutAmount;

            const item = {
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                payoutAmount: calc.payoutAmount,
                metrics: calc.metrics
            };
            contentPayouts.push(item);

            if (!payoutsByCreator.has(creator._id.toString())) {
                payoutsByCreator.set(creator._id.toString(), {
                    creatorId: creator._id,
                    totalPayout: 0,
                    contents: []
                });
            }
            
            const creatorGroup = payoutsByCreator.get(creator._id.toString());
            creatorGroup.totalPayout += calc.payoutAmount;
            creatorGroup.contents.push(item);
        }

        console.log(`Evaluating ${contentPayouts.length} content items across ${payoutsByCreator.size} creators...`);

        // Execute transactions per creator
        for (const [creatorId, group] of payoutsByCreator.entries()) {
            const session = await mongoose.startSession();
            try {
                session.startTransaction();
                
                let wallet = await SecondaryWallet.findOne({ userId: creatorId }).session(session);
                if (!wallet) {
                    wallet = new SecondaryWallet({ userId: creatorId, balance: 0, status: 'active' });
                }

                // Credit the wallet
                wallet.balance += group.totalPayout;
                await wallet.save({ session });

                // Create transactions per content
                for (const item of group.contents) {
                    const balanceAfter = wallet.balance; // Simplified balance calculation
                    const txn = new WalletTransaction({
                        walletId: wallet._id,
                        walletType: 'secondary',
                        type: 'engagement_earning_credit',
                        amount: item.payoutAmount,
                        balanceAfter,
                        relatedContentId: item.contentId,
                        status: 'completed',
                        idempotencyKey: `eng_${month}_${item.contentId}_${new Date().getTime()}`
                    });
                    await txn.save({ session });
                }
                
                await session.commitTransaction();

                // Dispatch professional email notification to creator
                (async () => {
                    try {
                        const creatorUser = await User.findById(creatorId).select('email contact userName channelName').lean();
                        const recipientEmail = creatorUser?.email || (creatorUser?.contact && creatorUser.contact.includes('@') ? creatorUser.contact : null);
                        if (recipientEmail) {
                            await sendAdminEmail('engagementPayoutCredited', recipientEmail, {
                                creatorName: creatorUser.channelName || creatorUser.userName || 'Creator',
                                totalAmount: group.totalPayout,
                                contentCount: group.contents.length,
                                payoutMonth: month,
                                contentBreakdown: group.contents
                            });
                        }
                    } catch (emailErr) {
                        console.error(`⚠️ Failed to send engagement payout email to creator ${creatorId}:`, emailErr.message);
                    }
                })();
            } catch (error) {
                console.error(`❌ Transaction failed for creator ${creatorId}:`, error);
                await session.abortTransaction();
            } finally {
                session.endSession();
            }
        }

        // Save record
        const record = await EngagementPayout.create({
            payoutMonth: month,
            totalPool,
            totalContentEvaluated: allContent.length,
            totalCreatorsPaid: payoutsByCreator.size,
            totalContentPaid: contentPayouts.length,
            minViewsThreshold: minViews,
            contentPayouts,
            periodStart,
            periodEnd,
            initiatedBy: req.admin?._id,
            status: 'completed'
        });

        console.log(`✅ [ENGAGEMENT_PAYOUT_SUCCESS] Total pool: ₹${totalPool.toFixed(2)}, Creators: ${payoutsByCreator.size}`);

        return res.json({
            success: true,
            message: "Engagement payout completed successfully",
            totalDistributed: totalPool,
            creatorsPaid: payoutsByCreator.size,
            contentEvaluated: allContent.length,
            contentPaid: contentPayouts.length,
            bannedSkipped: allContent.length - contentPayouts.length,
            payoutMonth: record.payoutMonth,
        });

    } catch (error) {
        console.error('❌ Error running engagement payout:', error);
        return res.status(500).json({ error: 'Failed to run engagement payout' });
    }
};

export const previewEngagementPayout = async (req, res) => {
    try {
        const minViews = req.query.minViews !== undefined ? parseInt(req.query.minViews) : 0;
        
        const allContent = await Content.find({ status: { $ne: 'removed' }, views: { $gte: Math.max(minViews, 1) } }).populate('userId', 'userName channelName channelBanned').lean();
        
        const contentPayouts = [];
        let totalPool = 0;
        let totalCreators = new Set();

        for (const content of allContent) {
            const creator = content.userId;
            if (!creator || creator.channelBanned) continue;

            const calc = await calculateContentPayout(content);
            if (calc.payoutAmount <= 0) continue;

            totalPool += calc.payoutAmount;
            totalCreators.add(creator._id.toString());

            contentPayouts.push({
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creator._id,
                creatorName: creator.channelName || creator.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                payoutAmount: calc.payoutAmount,
                metrics: calc.metrics
            });
        }

        return res.json({
            success: true,
            totalContent: contentPayouts.length,
            totalProjectedPayout: totalPool,
            totalCreators: totalCreators.size,
            minViewsThreshold: minViews,
            contentBreakdown: contentPayouts.map(cp => ({
                contentId: cp.contentId,
                contentTitle: cp.contentTitle,
                contentType: cp.contentType,
                creatorName: cp.creatorName,
                views: cp.metrics.views,
                engagementMultiplier: cp.engagementMultiplier,
                payoutAmount: cp.payoutAmount,
                metrics: cp.metrics,
            }))
        });

    } catch (error) {
        console.error('❌ Error previewing engagement payout:', error);
        return res.status(500).json({ error: 'Failed to preview engagement payout' });
    }
};

export const getEngagementPayoutReport = async (req, res) => {
    try {
        const { month } = req.params;
        const report = await EngagementPayout.findOne({ payoutMonth: month }).lean();
        
        if (!report) {
            return res.json({ success: true, payouts: [] });
        }
        
        return res.json({ success: true, payouts: [report] });
    } catch (error) {
        console.error('❌ Error getting engagement payout report:', error);
        return res.status(500).json({ error: 'Failed to fetch report' });
    }
};

export const runSingleCreatorEngagementPayout = async (req, res) => {
    try {
        const { userId, otp, minViews = 0 } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        if (!otp) {
            return res.status(400).json({ error: "Admin OTP is required to initiate engagement payout" });
        }

        const contact = req.admin?.contact;
        if (!contact) {
            return res.status(401).json({ error: "Admin contact details missing" });
        }

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

        // OTP verified — clear session
        await OtpSession.deleteOne({ _id: otpSession._id });

        const now = new Date();
        const month = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}_${userId}`;

        const creatorUser = await User.findById(userId).lean();
        if (!creatorUser || creatorUser.channelBanned) {
            return res.status(400).json({ error: "Creator not found or banned" });
        }

        const allContent = await Content.find({ userId, status: { $ne: 'removed' }, views: { $gte: Math.max(minViews, 1) } }).populate('userId', 'userName channelName channelBanned').lean();
        
        const contentPayouts = [];
        let totalPayout = 0;

        for (const content of allContent) {
            const calc = await calculateContentPayout(content);
            if (calc.payoutAmount <= 0) continue;

            totalPayout += calc.payoutAmount;

            contentPayouts.push({
                contentId: content._id,
                contentTitle: content.title,
                contentType: content.contentType,
                creatorId: creatorUser._id,
                creatorName: creatorUser.channelName || creatorUser.userName || 'Unknown',
                engagementScore: calc.engagementScore,
                engagementMultiplier: calc.engagementMultiplier,
                payoutAmount: calc.payoutAmount,
                metrics: calc.metrics
            });
        }

        if (totalPayout <= 0) {
            return res.json({ success: true, message: "No eligible payouts for this creator", data: { totalPayout: 0 } });
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

            for (const item of contentPayouts) {
                const txn = new WalletTransaction({
                    walletId: wallet._id,
                    walletType: 'secondary',
                    type: 'engagement_earning_credit',
                    amount: item.payoutAmount,
                    balanceAfter: wallet.balance,
                    relatedContentId: item.contentId,
                    status: 'completed',
                    idempotencyKey: `eng_single_${month}_${item.contentId}_${new Date().getTime()}`
                });
                await txn.save({ session });
            }
            
            await session.commitTransaction();

            // Dispatch professional email notification to creator
            (async () => {
                try {
                    const recipientEmail = creatorUser?.email || (creatorUser?.contact && creatorUser.contact.includes('@') ? creatorUser.contact : null);
                    if (recipientEmail) {
                        await sendAdminEmail('engagementPayoutCredited', recipientEmail, {
                            creatorName: creatorUser.channelName || creatorUser.userName || 'Creator',
                            totalAmount: totalPayout,
                            contentCount: contentPayouts.length,
                            payoutMonth: month,
                            contentBreakdown: contentPayouts
                        });
                    }
                } catch (emailErr) {
                    console.error(`⚠️ Failed to send single engagement payout email to creator ${userId}:`, emailErr.message);
                }
            })();
        } catch (error) {
            console.error(`❌ Transaction failed for creator ${userId}:`, error);
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }

        const record = await EngagementPayout.create({
            payoutMonth: month, // unique modifier used to prevent clash if run multiple times?
            totalPool: totalPayout,
            totalContentEvaluated: allContent.length,
            totalCreatorsPaid: 1,
            totalContentPaid: contentPayouts.length,
            minViewsThreshold: minViews,
            contentPayouts,
            periodStart: new Date(0), // simplified
            periodEnd: now,
            initiatedBy: req.admin?._id,
            status: 'completed'
        });

        return res.json({
            success: true,
            message: `Single creator engagement payout completed successfully`,
            data: {
                totalPool: record.totalPool,
                totalContentPaid: record.totalContentPaid
            }
        });

    } catch (error) {
        console.error('❌ Error running single creator payout:', error);
        return res.status(500).json({ error: 'Failed to run single creator payout' });
    }
};
