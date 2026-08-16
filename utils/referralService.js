import mongoose from 'mongoose';
import crypto from 'node:crypto';
import User from '../models/user.model.js';
import Referral from '../models/referral.model.js';
import PrimaryWallet from '../models/primaryWallet.model.js';
import SecondaryWallet from '../models/secondaryWallet.model.js';
import WalletTransaction from '../models/walletTransaction.model.js';
import { creditWallet, ensurePrimaryWallet, ensureSecondaryWallet } from './walletService.js';
import { sendAdminEmail } from '../services/adminEmailService.js';
import ReferralSettings from '../models/referralSettings.model.js';

/**
 * Get current referral settings (singleton).
 * Returns { isEnabled, referrerBonusAmount, referredBonusAmount }
 */
export async function getReferralSettings() {
    return await ReferralSettings.getSettings();
}

/**
 * Generate a unique 8-character alphanumeric referral code for a user.
 * Idempotent — returns existing code if already generated.
 */
export async function generateReferralCode(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.referralCode) return user.referralCode;
    
    let code;
    let attempts = 0;
    do {
        code = crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
        const existing = await User.findOne({ referralCode: code });
        if (!existing) break;
        attempts++;
    } while (attempts < 10);
    
    if (attempts >= 10) throw new Error('Failed to generate unique referral code');
    
    user.referralCode = code;
    await user.save();
    return code;
}

/**
 * Process a referral during signup. Creates a Referral record.
 * Called after new user is created.
 */
export async function processReferralSignup(referralCode, newUserId) {
    console.log(`[REFERRAL] Processing signup referral: code=${referralCode}, newUser=${newUserId}`);
    
    const settings = await getReferralSettings();
    if (!settings.isEnabled) {
        console.log(`[REFERRAL] Referral program is disabled, ignoring`);
        return null;
    }
    
    const referrer = await User.findOne({ referralCode });
    if (!referrer) {
        console.log(`[REFERRAL] Invalid referral code: ${referralCode}`);
        return null;
    }
    
    // Prevent self-referral
    if (referrer._id.toString() === newUserId.toString()) {
        console.log(`[REFERRAL] Self-referral attempted, ignoring`);
        return null;
    }
    
    // Check if this user was already referred
    const existing = await Referral.findOne({ referredUserId: newUserId });
    if (existing) {
        console.log(`[REFERRAL] User ${newUserId} already has a referral record`);
        return existing;
    }
    
    try {
        const referral = await Referral.create({
            referrerId: referrer._id,
            referredUserId: newUserId,
            referralCode,
            status: 'pending',
        });
        
        // Update the new user's referredBy field
        await User.findByIdAndUpdate(newUserId, { referredBy: referrer._id });
        
        console.log(`[REFERRAL] Created referral record: ${referral._id}`);
        return referral;
    } catch (err) {
        if (err.code === 11000) {
            console.log(`[REFERRAL] Duplicate referral record, ignoring`);
            return await Referral.findOne({ referredUserId: newUserId });
        }
        throw err;
    }
}

/**
 * Mark that a referred user has uploaded content.
 * Called when content status changes to 'completed'.
 */
export async function markContentUploaded(referredUserId, contentId) {
    const referral = await Referral.findOne({ 
        referredUserId, 
        status: 'pending' 
    });
    
    if (!referral) return null;
    
    referral.status = 'content_uploaded';
    referral.contentId = contentId;
    await referral.save();
    
    console.log(`[REFERRAL] Marked content uploaded for referral ${referral._id}`);
    return referral;
}

/**
 * Approve a referral — atomic wallet credits for both parties.
 * Uses MongoDB session for atomicity, same pattern as PPV purchase.
 * 
 * Referrer: ₹25 → Secondary Wallet (earnings)
 * Referred: ₹25 → Primary Wallet (spending credit)
 */
export async function approveReferral(referralId, adminId) {
    console.log(`\n=================== [REFERRAL_APPROVE_INIT] ===================`);
    console.log(`ReferralID: ${referralId} | AdminID: ${adminId}`);
    
    const referral = await Referral.findById(referralId)
        .populate('referrerId', 'userName channelName contact')
        .populate('referredUserId', 'userName channelName contact');
    
    if (!referral) throw new Error('Referral not found');
    if (referral.status === 'approved') {
        console.log(`[REFERRAL] Already approved, skipping`);
        return referral;
    }
    if (referral.status === 'rejected') throw new Error('Cannot approve a rejected referral');
    
    const settings = await getReferralSettings();
    if (!settings.isEnabled) throw new Error('Referral program is currently disabled');
    
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            // Double-entry guard
            const freshReferral = await Referral.findById(referralId).session(session);
            if (freshReferral.referrerCredited || freshReferral.referredCredited) {
                console.log(`[REFERRAL] Already credited, skipping transaction`);
                result = freshReferral;
                return;
            }
            
            // Ensure wallets exist
            const referrerSecondaryWallet = await ensureSecondaryWallet(referral.referrerId._id);
            const referredPrimaryWallet = await ensurePrimaryWallet(referral.referredUserId._id);
            
            // Credit referrer's secondary wallet
            const referrerTxn = await creditWallet(
                referrerSecondaryWallet._id,
                'secondary',
                settings.referrerBonusAmount,
                'referral_bonus_credit',
                {
                    relatedBuyerId: referral.referredUserId._id,
                },
                `referral_approve_referrer_${referralId}`,
                session
            );
            
            // Credit referred user's primary wallet
            const referredTxn = await creditWallet(
                referredPrimaryWallet._id,
                'primary',
                settings.referredBonusAmount,
                'referral_bonus_credit',
                {
                    relatedBuyerId: referral.referrerId._id,
                },
                `referral_approve_referred_${referralId}`,
                session
            );
            
            // Update referral record atomically
            await Referral.findByIdAndUpdate(referralId, {
                status: 'approved',
                approvedAt: new Date(),
                approvedBy: adminId,
                referrerCredited: true,
                referredCredited: true,
                referrerTransactionId: referrerTxn._id,
                referredTransactionId: referredTxn._id,
                referrerBonusAmount: settings.referrerBonusAmount,
                referredBonusAmount: settings.referredBonusAmount,
            }, { session });
            
            result = { referrerTxn, referredTxn };
        });
        
        console.log(`=================== [REFERRAL_APPROVE_SUCCESS] ===================\n`);
        
        // Send emails asynchronously (non-blocking)
        const referrerName = referral.referrerId.channelName || referral.referrerId.userName;
        const referredName = referral.referredUserId.channelName || referral.referredUserId.userName;
        const referrerEmail = referral.referrerId.contact;
        const referredEmail = referral.referredUserId.contact;
        
        if (referrerEmail && referrerEmail.includes('@')) {
            sendAdminEmail('referralApprovedReferrer', referrerEmail, {
                referrerName,
                referredName,
                bonusAmount: settings.referrerBonusAmount,
            }).catch(err => console.error('[REFERRAL] Failed to send referrer approval email:', err.message));
        }
        
        if (referredEmail && referredEmail.includes('@')) {
            sendAdminEmail('referralApprovedReferred', referredEmail, {
                referrerName,
                referredName,
                bonusAmount: settings.referredBonusAmount,
            }).catch(err => console.error('[REFERRAL] Failed to send referred approval email:', err.message));
        }
        
        return result;
    } catch (err) {
        console.error(`[REFERRAL_APPROVE_ERROR] ${err.message}`);
        throw err;
    } finally {
        await session.endSession();
    }
}

/**
 * Partially approve a referral — atomic wallet credit for the approved party.
 */
export async function partialApproveReferral(referralId, adminId, { approveReferrer, approveReferred, rejectionReason }) {
    if (approveReferrer && approveReferred) {
        return await approveReferral(referralId, adminId);
    }
    
    console.log(`\n=================== [REFERRAL_PARTIAL_APPROVE_INIT] ===================`);
    console.log(`ReferralID: ${referralId} | AdminID: ${adminId} | Referrer: ${approveReferrer} | Referred: ${approveReferred}`);
    
    const referral = await Referral.findById(referralId)
        .populate('referrerId', 'userName channelName contact')
        .populate('referredUserId', 'userName channelName contact');
    
    if (!referral) throw new Error('Referral not found');
    if (referral.status === 'approved' || referral.status === 'partial_approved') {
        throw new Error('Referral is already approved or partially approved');
    }
    if (referral.status === 'rejected') throw new Error('Cannot approve a rejected referral');
    
    const settings = await getReferralSettings();
    if (!settings.isEnabled) throw new Error('Referral program is currently disabled');
    
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            const freshReferral = await Referral.findById(referralId).session(session);
            if (freshReferral.referrerCredited || freshReferral.referredCredited) {
                console.log(`[REFERRAL] Already credited, skipping transaction`);
                result = freshReferral;
                return;
            }
            
            let referrerTxn = null;
            let referredTxn = null;
            
            if (approveReferrer) {
                const referrerSecondaryWallet = await ensureSecondaryWallet(referral.referrerId._id);
                referrerTxn = await creditWallet(
                    referrerSecondaryWallet._id,
                    'secondary',
                    settings.referrerBonusAmount,
                    'referral_bonus_credit',
                    { relatedBuyerId: referral.referredUserId._id },
                    `referral_partial_approve_referrer_${referralId}`,
                    session
                );
            }
            
            if (approveReferred) {
                const referredPrimaryWallet = await ensurePrimaryWallet(referral.referredUserId._id);
                referredTxn = await creditWallet(
                    referredPrimaryWallet._id,
                    'primary',
                    settings.referredBonusAmount,
                    'referral_bonus_credit',
                    { relatedBuyerId: referral.referrerId._id },
                    `referral_partial_approve_referred_${referralId}`,
                    session
                );
            }
            
            await Referral.findByIdAndUpdate(referralId, {
                status: 'partial_approved',
                approvedAt: new Date(),
                approvedBy: adminId,
                referrerCredited: approveReferrer,
                referredCredited: approveReferred,
                referrerTransactionId: referrerTxn ? referrerTxn._id : undefined,
                referredTransactionId: referredTxn ? referredTxn._id : undefined,
                referrerBonusAmount: approveReferrer ? settings.referrerBonusAmount : 0,
                referredBonusAmount: approveReferred ? settings.referredBonusAmount : 0,
                partialRejectionReason: rejectionReason,
                rejectedParty: approveReferrer ? 'referred' : 'referrer'
            }, { session });
            
            result = { referrerTxn, referredTxn };
        });
        
        console.log(`=================== [REFERRAL_PARTIAL_APPROVE_SUCCESS] ===================\n`);
        
        const referrerName = referral.referrerId.channelName || referral.referrerId.userName;
        const referredName = referral.referredUserId.channelName || referral.referredUserId.userName;
        const referrerEmail = referral.referrerId.contact;
        const referredEmail = referral.referredUserId.contact;
        
        if (approveReferrer && referrerEmail && referrerEmail.includes('@')) {
            sendAdminEmail('referralPartialApproved', referrerEmail, {
                userName: referrerName,
                bonusAmount: settings.referrerBonusAmount,
            }).catch(err => console.error('[REFERRAL] Failed to send referrer approval email:', err.message));
        } else if (!approveReferrer && referrerEmail && referrerEmail.includes('@')) {
            sendAdminEmail('referralPartialRejected', referrerEmail, {
                userName: referrerName,
                reason: rejectionReason,
            }).catch(err => console.error('[REFERRAL] Failed to send referrer rejection email:', err.message));
        }
        
        if (approveReferred && referredEmail && referredEmail.includes('@')) {
            sendAdminEmail('referralPartialApproved', referredEmail, {
                userName: referredName,
                bonusAmount: settings.referredBonusAmount,
            }).catch(err => console.error('[REFERRAL] Failed to send referred approval email:', err.message));
        } else if (!approveReferred && referredEmail && referredEmail.includes('@')) {
            sendAdminEmail('referralPartialRejected', referredEmail, {
                userName: referredName,
                reason: rejectionReason,
            }).catch(err => console.error('[REFERRAL] Failed to send referred rejection email:', err.message));
        }
        
        return result;
    } catch (err) {
        console.error(`[REFERRAL_PARTIAL_APPROVE_ERROR] ${err.message}`);
        throw err;
    } finally {
        await session.endSession();
    }
}

/**
 * Reject a referral with a reason. Sends rejection emails to both parties.
 */
export async function rejectReferral(referralId, adminId, reason) {
    console.log(`[REFERRAL] Rejecting referral ${referralId}: ${reason}`);
    
    const referral = await Referral.findById(referralId)
        .populate('referrerId', 'userName channelName contact')
        .populate('referredUserId', 'userName channelName contact');
    
    if (!referral) throw new Error('Referral not found');
    if (referral.status === 'approved') throw new Error('Cannot reject an already approved referral');
    if (referral.status === 'rejected') {
        console.log(`[REFERRAL] Already rejected, skipping`);
        return referral;
    }
    
    referral.status = 'rejected';
    referral.rejectionReason = reason;
    referral.rejectedAt = new Date();
    referral.approvedBy = adminId;
    await referral.save();
    
    // Send rejection emails asynchronously
    const referrerName = referral.referrerId.channelName || referral.referrerId.userName;
    const referredName = referral.referredUserId.channelName || referral.referredUserId.userName;
    const referrerEmail = referral.referrerId.contact;
    const referredEmail = referral.referredUserId.contact;
    
    if (referrerEmail && referrerEmail.includes('@')) {
        sendAdminEmail('referralRejectedReferrer', referrerEmail, {
            referrerName,
            referredName,
            reason,
        }).catch(err => console.error('[REFERRAL] Failed to send referrer rejection email:', err.message));
    }
    
    if (referredEmail && referredEmail.includes('@')) {
        sendAdminEmail('referralRejectedReferred', referredEmail, {
            referrerName,
            referredName,
            reason,
        }).catch(err => console.error('[REFERRAL] Failed to send referred rejection email:', err.message));
    }
    
    return referral;
}
