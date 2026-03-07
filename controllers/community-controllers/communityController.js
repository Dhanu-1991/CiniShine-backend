import mongoose from 'mongoose';
import Community from '../../models/community.model.js';
import CommunityMember from '../../models/communityMember.model.js';
import CommunityImportEvent from '../../models/communityImportEvent.model.js';
import ContentToCommunity from '../../models/contentToCommunity.model.js';
import Content from '../../models/content.model.js';
import ActionLog from '../../models/actionLog.model.js';
import User from '../../models/user.model.js';

/**
 * Helper: generate a URL-safe slug from a community name
 */
function generateSlug(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .substring(0, 120);
}

/**
 * Helper: log an action to the audit trail
 */
async function logAction(userId, communityId, action, payload = {}) {
    try {
        await ActionLog.create({ userId, communityId, action, payload });
    } catch (e) {
        console.error('ActionLog write failed:', e.message);
    }
}

/**
 * Helper: check if a user has a channel (channelName is set)
 */
async function userHasChannel(userId) {
    const user = await User.findById(userId).select('channelName channelHandle').lean();
    return !!(user && user.channelName);
}

/**
 * Helper: check posting authorization for a user in a community
 */
async function checkPostingAuth(userId, community) {
    const member = await CommunityMember.findOne({
        communityId: community._id,
        userId,
        status: 'ACTIVE'
    }).lean();

    if (!member) {
        return { allowed: false, reason: 'Not an active member of this community' };
    }

    if (community.type === 'PRIVATE' && member.status !== 'ACTIVE') {
        return { allowed: false, reason: 'Membership not active' };
    }

    switch (community.postingPolicy) {
        case 'ANY_MEMBER':
            return { allowed: true, member };
        case 'ADMINS_ONLY':
            if (['ADMIN', 'OWNER'].includes(member.role)) return { allowed: true, member };
            return { allowed: false, reason: 'Only admins can post in this community' };
        case 'MODS_AND_ADMINS':
            if (['MODERATOR', 'ADMIN', 'OWNER'].includes(member.role)) return { allowed: true, member };
            return { allowed: false, reason: 'Only moderators and admins can post in this community' };
        case 'OWNER_ONLY':
            if (member.role === 'OWNER') return { allowed: true, member };
            return { allowed: false, reason: 'Only the owner can post in this community' };
        default:
            return { allowed: true, member };
    }
}

// ═══════════════════════════════════════════════════
// POST /api/v2/communities — Create a community
// ═══════════════════════════════════════════════════
export const createCommunity = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Validate user has a channel
        const hasChannel = await userHasChannel(userId);
        if (!hasChannel) {
            return res.status(400).json({
                error: 'You must create a channel before creating a community.'
            });
        }

        const {
            name,
            description,
            type,
            includeExistingContent = false,
            importedVisibility,
            avatarUrl,
            bannerUrl,
            isSearchVisible = true,
            postingPolicy = 'ANY_MEMBER'
        } = req.body;

        // Validate required fields
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }
        if (!['PUBLIC', 'PRIVATE'].includes(type)) {
            return res.status(400).json({ error: 'Type must be PUBLIC or PRIVATE' });
        }
        if (includeExistingContent && !['VISIBLE_TO_ALL', 'MEMBERS_ONLY', 'NO_BACKFILL'].includes(importedVisibility)) {
            return res.status(400).json({ error: 'importedVisibility is required when including existing content' });
        }

        // Generate slug and check uniqueness
        let slug = generateSlug(name);
        const existingSlug = await Community.findOne({ slug }).lean();
        if (existingSlug) {
            slug = `${slug}-${Date.now().toString(36)}`;
        }

        // Check name uniqueness
        const existingName = await Community.findOne({ name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }).lean();
        if (existingName) {
            return res.status(409).json({ error: 'A community with this name already exists' });
        }

        // Create community
        const community = await Community.create({
            name,
            slug,
            description,
            type,
            ownerId: userId,
            avatarUrl,
            bannerUrl,
            isSearchVisible,
            postingPolicy,
            memberCount: 1
        });

        // Create owner membership
        await CommunityMember.create({
            communityId: community._id,
            userId,
            role: 'OWNER',
            status: 'ACTIVE',
            joinSource: 'manual'
        });

        let importEvent = null;

        // Import existing channel content if requested
        if (includeExistingContent) {
            const channelContents = await Content.find({
                userId,
                contentType: { $in: ['video', 'short', 'audio', 'post'] },
                status: { $in: ['completed', 'uploading'] },
                visibility: { $ne: 'private' }
            }).select('_id').lean();

            importEvent = await CommunityImportEvent.create({
                communityId: community._id,
                importedByUserId: userId,
                importedAt: new Date(),
                importedCount: channelContents.length,
                visibility: importedVisibility,
                status: 'completed'
            });

            // Create content-to-community links
            if (channelContents.length > 0) {
                const links = channelContents.map(c => ({
                    contentId: c._id,
                    communityId: community._id,
                    isImported: true,
                    createdAt: new Date()
                }));

                await ContentToCommunity.insertMany(links, { ordered: false }).catch(() => { });

                // Update content records with import metadata
                await Content.updateMany(
                    { _id: { $in: channelContents.map(c => c._id) } },
                    {
                        $set: {
                            importedFromChannel: true,
                            importedByCommunityId: community._id,
                            importedAt: new Date(),
                            importedByUserId: userId
                        }
                    }
                );
            }

            // Update community with import info
            community.importedContentFlag = true;
            community.importedVisibility = importedVisibility;
            community.importEventId = importEvent._id;
            community.importedAt = importEvent.importedAt;
            community.contentCount = channelContents.length;
            await community.save();
        }

        await logAction(userId, community._id, 'community_created', {
            name, type, includeExistingContent, importedVisibility,
            importedCount: importEvent?.importedCount || 0
        });

        return res.status(201).json({
            community,
            importEvent: importEvent ? {
                id: importEvent._id,
                importedCount: importEvent.importedCount,
                visibility: importEvent.visibility,
                status: importEvent.status
            } : null
        });
    } catch (error) {
        console.error('createCommunity error:', error);
        if (error.code === 11000) {
            return res.status(409).json({ error: 'Community name or slug already exists' });
        }
        return res.status(500).json({ error: 'Failed to create community' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities — List communities
// ═══════════════════════════════════════════════════
export const listCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { filter = 'all', search, cursor, limit = 20 } = req.query;
        const pageLimit = Math.min(parseInt(limit) || 20, 50);

        let query = {};

        // Build filter
        switch (filter) {
            case 'public':
                query.type = 'PUBLIC';
                query.isSearchVisible = true;
                break;
            case 'private':
                // Only show private communities the user is a member of
                if (userId) {
                    const memberships = await CommunityMember.find({
                        userId,
                        status: 'ACTIVE'
                    }).select('communityId').lean();
                    query._id = { $in: memberships.map(m => m.communityId) };
                    query.type = 'PRIVATE';
                } else {
                    return res.json({ communities: [], nextCursor: null });
                }
                break;
            case 'my':
                if (!userId) return res.status(401).json({ error: 'Authentication required' });
                const myMemberships = await CommunityMember.find({
                    userId,
                    status: { $in: ['ACTIVE', 'PENDING'] }
                }).select('communityId').lean();
                query._id = { $in: myMemberships.map(m => m.communityId) };
                break;
            case 'owned':
                if (!userId) return res.status(401).json({ error: 'Authentication required' });
                query.ownerId = userId;
                break;
            default: // 'all'
                if (userId) {
                    // Show all public + communities user is member of
                    const allMemberships = await CommunityMember.find({
                        userId,
                        status: 'ACTIVE'
                    }).select('communityId').lean();
                    query.$or = [
                        { type: 'PUBLIC', isSearchVisible: true },
                        { _id: { $in: allMemberships.map(m => m.communityId) } }
                    ];
                } else {
                    query.type = 'PUBLIC';
                    query.isSearchVisible = true;
                }
        }

        // Cursor-based pagination
        if (cursor) {
            query._id = { ...query._id, $lt: cursor };
        }

        // Search
        if (search) {
            query.name = { $regex: search, $options: 'i' };
        }

        const communities = await Community.find(query)
            .sort({ createdAt: -1 })
            .limit(pageLimit + 1)
            .populate('ownerId', 'userName channelName channelPicture channelHandle')
            .lean();

        const hasMore = communities.length > pageLimit;
        if (hasMore) communities.pop();

        // Add membership info if user is authenticated
        let enriched = communities;
        if (userId) {
            const communityIds = communities.map(c => c._id);
            const memberships = await CommunityMember.find({
                communityId: { $in: communityIds },
                userId
            }).lean();
            const memberMap = {};
            memberships.forEach(m => { memberMap[m.communityId.toString()] = m; });

            enriched = communities.map(c => ({
                ...c,
                membership: memberMap[c._id.toString()] || null,
                isOwner: c.ownerId?._id?.toString() === userId || c.ownerId?.toString() === userId
            }));
        }

        return res.json({
            communities: enriched,
            nextCursor: hasMore ? communities[communities.length - 1]._id : null
        });
    } catch (error) {
        console.error('listCommunities error:', error);
        return res.status(500).json({ error: 'Failed to list communities' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id — Get community details
// ═══════════════════════════════════════════════════
export const getCommunity = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        // Support lookup by ObjectId or communityId handle
        let community;
        if (mongoose.Types.ObjectId.isValid(id)) {
            community = await Community.findById(id)
                .populate('ownerId', 'userName channelName channelPicture channelHandle')
                .lean();
        }
        if (!community) {
            community = await Community.findOne({ communityId: id })
                .populate('ownerId', 'userName channelName channelPicture channelHandle')
                .lean();
        }

        if (!community) {
            return res.status(404).json({ error: 'Community not found' });
        }

        // Check access for private communities
        let membership = null;
        if (userId) {
            membership = await CommunityMember.findOne({
                communityId: id,
                userId
            }).lean();
        }

        if (community.type === 'PRIVATE' && (!membership || membership.status !== 'ACTIVE')) {
            // Return limited info for private communities
            return res.json({
                community: {
                    _id: community._id,
                    name: community.name,
                    slug: community.slug,
                    type: community.type,
                    description: community.description,
                    avatarUrl: community.avatarUrl,
                    bannerUrl: community.bannerUrl,
                    memberCount: community.memberCount,
                    isPrivate: true
                },
                membership: membership || null
            });
        }

        return res.json({
            community,
            membership: membership || null,
            isOwner: community.ownerId?._id?.toString() === userId || community.ownerId?.toString() === userId
        });
    } catch (error) {
        console.error('getCommunity error:', error);
        return res.status(500).json({ error: 'Failed to get community' });
    }
};

// ═══════════════════════════════════════════════════
// PUT /api/v2/communities/:id — Update community
// ═══════════════════════════════════════════════════
export const updateCommunity = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const member = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN'] }
        }).lean();

        if (!member) {
            return res.status(403).json({ error: 'Only owners and admins can update community settings' });
        }

        const allowedFields = ['name', 'description', 'avatarUrl', 'bannerUrl', 'isSearchVisible', 'postingPolicy', 'settings'];

        // Only OWNER can change community type and name
        if (member.role === 'OWNER') {
            allowedFields.push('type');
        }

        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        // Validate type if changing
        if (updates.type && !['PUBLIC', 'PRIVATE'].includes(updates.type)) {
            return res.status(400).json({ error: 'Type must be PUBLIC or PRIVATE' });
        }

        // If name changes, regenerate slug
        if (updates.name) {
            updates.slug = generateSlug(updates.name);
            const existingSlug = await Community.findOne({ slug: updates.slug, _id: { $ne: id } }).lean();
            if (existingSlug) {
                updates.slug = `${updates.slug}-${Date.now().toString(36)}`;
            }
        }

        const community = await Community.findByIdAndUpdate(id, { $set: updates }, { new: true })
            .populate('ownerId', 'userName channelName channelPicture channelHandle');

        await logAction(userId, id, 'community_updated', updates);

        return res.json({ community });
    } catch (error) {
        console.error('updateCommunity error:', error);
        return res.status(500).json({ error: 'Failed to update community' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/join — Join a community
// ═══════════════════════════════════════════════════
export const joinCommunity = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const community = await Community.findById(id).lean();
        if (!community) return res.status(404).json({ error: 'Community not found' });

        // Check if already a member
        const existing = await CommunityMember.findOne({ communityId: id, userId }).lean();
        if (existing) {
            if (existing.status === 'BANNED') {
                return res.status(403).json({ error: 'You are banned from this community' });
            }
            if (existing.status === 'PENDING') {
                return res.json({ message: 'Your join request is pending approval', membership: existing });
            }
            return res.json({ message: 'Already a member', membership: existing });
        }

        const memberData = {
            communityId: id,
            userId,
            role: 'MEMBER',
            joinSource: community.type === 'PRIVATE' ? 'request' : 'manual'
        };

        if (community.type === 'PUBLIC') {
            memberData.status = 'ACTIVE';
        } else {
            memberData.status = 'PENDING';
            memberData.role = 'PENDING';
        }

        const membership = await CommunityMember.create(memberData);

        // Update member count for public (immediate join)
        if (community.type === 'PUBLIC') {
            await Community.findByIdAndUpdate(id, { $inc: { memberCount: 1 } });
        }

        await logAction(userId, id, community.type === 'PUBLIC' ? 'community_joined' : 'community_join_requested', {});

        return res.status(201).json({
            message: community.type === 'PUBLIC' ? 'Joined successfully' : 'Join request submitted',
            membership
        });
    } catch (error) {
        console.error('joinCommunity error:', error);
        if (error.code === 11000) {
            return res.json({ message: 'Already a member' });
        }
        return res.status(500).json({ error: 'Failed to join community' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/leave — Leave a community
// ═══════════════════════════════════════════════════
export const leaveCommunity = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const member = await CommunityMember.findOne({ communityId: id, userId }).lean();
        if (!member) return res.status(404).json({ error: 'Not a member' });

        if (member.role === 'OWNER') {
            // Owner must transfer ownership first
            const admins = await CommunityMember.find({
                communityId: id,
                role: 'ADMIN',
                status: 'ACTIVE'
            }).sort({ joinedAt: 1 }).lean();

            if (admins.length > 0) {
                // Auto-transfer to oldest admin
                await CommunityMember.findByIdAndUpdate(admins[0]._id, { role: 'OWNER' });
                await Community.findByIdAndUpdate(id, { ownerId: admins[0].userId });
                await logAction(userId, id, 'ownership_transferred', { newOwnerId: admins[0].userId.toString() });
            } else {
                // Find oldest active member
                const members = await CommunityMember.find({
                    communityId: id,
                    status: 'ACTIVE',
                    userId: { $ne: userId }
                }).sort({ joinedAt: 1 }).lean();

                if (members.length > 0) {
                    await CommunityMember.findByIdAndUpdate(members[0]._id, { role: 'OWNER' });
                    await Community.findByIdAndUpdate(id, { ownerId: members[0].userId });
                    await logAction(userId, id, 'ownership_transferred', { newOwnerId: members[0].userId.toString() });
                } else {
                    // Last member — soft-delete community?
                    // For now, allow leaving and keep community as orphaned
                }
            }
        }

        await CommunityMember.deleteOne({ communityId: id, userId });
        await Community.findByIdAndUpdate(id, { $inc: { memberCount: -1 } });
        await logAction(userId, id, 'community_left', {});

        return res.json({ message: 'Left community' });
    } catch (error) {
        console.error('leaveCommunity error:', error);
        return res.status(500).json({ error: 'Failed to leave community' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/approve/:memberId — Approve join request
// ═══════════════════════════════════════════════════
export const approveJoinRequest = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, memberId } = req.params;

        // Check caller is admin/owner
        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized to approve requests' });
        }

        const targetMember = await CommunityMember.findOneAndUpdate(
            { _id: memberId, communityId: id, status: 'PENDING' },
            { status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date() },
            { new: true }
        );

        if (!targetMember) {
            return res.status(404).json({ error: 'Pending member not found' });
        }

        await Community.findByIdAndUpdate(id, { $inc: { memberCount: 1 } });
        await logAction(userId, id, 'member_approved', { approvedUserId: targetMember.userId.toString() });

        return res.json({ message: 'Member approved', membership: targetMember });
    } catch (error) {
        console.error('approveJoinRequest error:', error);
        return res.status(500).json({ error: 'Failed to approve request' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/reject/:memberId — Reject join request
// ═══════════════════════════════════════════════════
export const rejectJoinRequest = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, memberId } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized to reject requests' });
        }

        await CommunityMember.findOneAndDelete({ _id: memberId, communityId: id, status: 'PENDING' });
        await logAction(userId, id, 'member_rejected', { rejectedMemberId: memberId });

        return res.json({ message: 'Request rejected' });
    } catch (error) {
        console.error('rejectJoinRequest error:', error);
        return res.status(500).json({ error: 'Failed to reject request' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/ban/:targetUserId — Ban a member
// ═══════════════════════════════════════════════════
export const banMember = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, targetUserId } = req.params;
        const { reason, expiresAt } = req.body || {};

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const targetMember = await CommunityMember.findOne({
            communityId: id,
            userId: targetUserId
        });

        if (!targetMember) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Can't ban owner or someone with higher/equal role
        const roleHierarchy = { OWNER: 4, ADMIN: 3, MODERATOR: 2, MEMBER: 1, PENDING: 0, BANNED: -1 };
        if (roleHierarchy[targetMember.role] >= roleHierarchy[callerMember.role]) {
            return res.status(403).json({ error: 'Cannot ban a member with equal or higher role' });
        }

        // MODERATOR can only do temporary bans
        if (callerMember.role === 'MODERATOR' && !expiresAt) {
            return res.status(403).json({ error: 'Moderators can only issue temporary bans. Provide an expiresAt date.' });
        }

        targetMember.status = 'BANNED';
        targetMember.role = 'BANNED';
        targetMember.bannedAt = new Date();
        targetMember.bannedBy = userId;
        targetMember.banReason = reason || null;
        targetMember.banExpiresAt = expiresAt ? new Date(expiresAt) : null;
        await targetMember.save();

        await Community.findByIdAndUpdate(id, { $inc: { memberCount: -1 } });
        await logAction(userId, id, 'member_banned', {
            bannedUserId: targetUserId,
            reason,
            temporary: !!expiresAt,
            expiresAt
        });

        return res.json({ message: 'Member banned', membership: targetMember });
    } catch (error) {
        console.error('banMember error:', error);
        return res.status(500).json({ error: 'Failed to ban member' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/members — List members
// ═══════════════════════════════════════════════════
export const listMembers = async (req, res) => {
    try {
        const { id } = req.params;
        const { status = 'ACTIVE', page = 1, limit = 200, search } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Role weight for sorting: OWNER > ADMIN > MODERATOR > MEMBER
        const roleWeight = { OWNER: 4, ADMIN: 3, MODERATOR: 2, MEMBER: 1 };

        const matchFilter = { communityId: new mongoose.Types.ObjectId(id), status };

        const pipeline = [
            { $match: matchFilter },
            // Populate user data
            { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'userInfo' } },
            { $unwind: '$userInfo' },
            // If search query, filter by name/handle
            ...(search && search.trim() ? [{
                $match: {
                    $or: [
                        { 'userInfo.userName': { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
                        { 'userInfo.channelName': { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
                        { 'userInfo.channelHandle': { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
                    ]
                }
            }] : []),
            // Count followers (users who have this user in their subscriptions)
            { $lookup: { from: 'users', localField: 'userInfo._id', foreignField: 'subscriptions', as: '_followers' } },
            {
                $addFields: {
                    followerCount: { $size: '$_followers' },
                    roleWeight: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$role', 'OWNER'] }, then: 4 },
                                { case: { $eq: ['$role', 'ADMIN'] }, then: 3 },
                                { case: { $eq: ['$role', 'MODERATOR'] }, then: 2 },
                            ],
                            default: 1
                        }
                    }
                }
            },
            { $sort: { roleWeight: -1, followerCount: -1 } },
            // Project final shape
            {
                $project: {
                    _id: 1,
                    communityId: 1,
                    role: 1,
                    status: 1,
                    joinedAt: 1,
                    followerCount: 1,
                    userId: {
                        _id: '$userInfo._id',
                        userName: '$userInfo.userName',
                        channelName: '$userInfo.channelName',
                        channelPicture: '$userInfo.channelPicture',
                        channelHandle: '$userInfo.channelHandle'
                    }
                }
            }
        ];

        // Get total before pagination
        const countPipeline = [...pipeline, { $count: 'total' }];
        const [countResult] = await CommunityMember.aggregate(countPipeline);
        const total = countResult?.total || 0;

        // Add pagination
        pipeline.push({ $skip: skip }, { $limit: parseInt(limit) });
        const members = await CommunityMember.aggregate(pipeline);

        return res.json({ members, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (error) {
        console.error('listMembers error:', error);
        return res.status(500).json({ error: 'Failed to list members' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/pending — List pending join requests
// ═══════════════════════════════════════════════════
export const listPendingRequests = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const pending = await CommunityMember.find({
            communityId: id,
            status: 'PENDING'
        })
            .sort({ joinedAt: -1 })
            .populate('userId', 'userName channelName channelPicture channelHandle')
            .lean();

        return res.json({ pending });
    } catch (error) {
        console.error('listPendingRequests error:', error);
        return res.status(500).json({ error: 'Failed to list pending requests' });
    }
};

// ═══════════════════════════════════════════════════
// PUT /api/v2/communities/:id/posting-policy — Update posting policy
// ═══════════════════════════════════════════════════
export const updatePostingPolicy = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        const { postingPolicy } = req.body;

        if (!['ANY_MEMBER', 'ADMINS_ONLY', 'MODS_AND_ADMINS', 'OWNER_ONLY'].includes(postingPolicy)) {
            return res.status(400).json({ error: 'Invalid posting policy' });
        }

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only owners and admins can change posting policy' });
        }

        const community = await Community.findByIdAndUpdate(id, { postingPolicy }, { new: true });
        await logAction(userId, id, 'posting_policy_updated', { postingPolicy });

        return res.json({ community });
    } catch (error) {
        console.error('updatePostingPolicy error:', error);
        return res.status(500).json({ error: 'Failed to update posting policy' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/user-communities — Communities user can post to
// ═══════════════════════════════════════════════════
export const getUserPostableCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Get all active memberships
        const memberships = await CommunityMember.find({
            userId,
            status: 'ACTIVE'
        }).lean();

        if (memberships.length === 0) {
            return res.json({ communities: [] });
        }

        const communityIds = memberships.map(m => m.communityId);
        const communities = await Community.find({
            _id: { $in: communityIds }
        }).select('name slug type postingPolicy avatarUrl').lean();

        // Filter to only communities where user can actually post
        const postable = [];
        for (const community of communities) {
            const member = memberships.find(m => m.communityId.toString() === community._id.toString());
            if (!member) continue;

            let canPost = false;
            switch (community.postingPolicy) {
                case 'ANY_MEMBER': canPost = true; break;
                case 'ADMINS_ONLY': canPost = ['ADMIN', 'OWNER'].includes(member.role); break;
                case 'MODS_AND_ADMINS': canPost = ['MODERATOR', 'ADMIN', 'OWNER'].includes(member.role); break;
                case 'OWNER_ONLY': canPost = member.role === 'OWNER'; break;
                default: canPost = true;
            }

            if (canPost) {
                postable.push({ ...community, memberRole: member.role });
            }
        }

        return res.json({ communities: postable });
    } catch (error) {
        console.error('getUserPostableCommunities error:', error);
        return res.status(500).json({ error: 'Failed to get communities' });
    }
};

// ═══════════════════════════════════════════════════
// DELETE /api/v2/communities/:id/imported — Clear imported content
// ═══════════════════════════════════════════════════
export const clearImportedContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            role: 'OWNER'
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only the owner can clear imported content' });
        }

        const deleted = await ContentToCommunity.deleteMany({ communityId: id, isImported: true });

        await Community.findByIdAndUpdate(id, {
            importedContentFlag: false,
            importedVisibility: null,
            $inc: { contentCount: -deleted.deletedCount }
        });

        await logAction(userId, id, 'imported_content_cleared', { deletedCount: deleted.deletedCount });

        return res.json({ message: 'Imported content cleared', deletedCount: deleted.deletedCount });
    } catch (error) {
        console.error('clearImportedContent error:', error);
        return res.status(500).json({ error: 'Failed to clear imported content' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/search — Search/discover communities
// ═══════════════════════════════════════════════════
export const searchCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { q = '', type, cursor, limit = 20 } = req.query;
        const pageLimit = Math.min(parseInt(limit) || 20, 50);

        // Only search visible communities
        const query = { isSearchVisible: true };

        // Text search
        if (q.trim()) {
            const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [
                { name: { $regex: escaped, $options: 'i' } },
                { description: { $regex: escaped, $options: 'i' } },
                { communityId: { $regex: escaped, $options: 'i' } }
            ];
        }

        // Type filter
        if (type && ['PUBLIC', 'PRIVATE'].includes(type)) {
            query.type = type;
        }

        if (cursor) {
            query._id = { ...query._id, $lt: cursor };
        }

        const communities = await Community.find(query)
            .sort({ memberCount: -1, createdAt: -1 })
            .limit(pageLimit + 1)
            .populate('ownerId', 'userName channelName channelPicture channelHandle')
            .lean();

        const hasMore = communities.length > pageLimit;
        if (hasMore) communities.pop();

        // Enrich with membership info
        let enriched = communities;
        if (userId) {
            const communityIds = communities.map(c => c._id);
            const memberships = await CommunityMember.find({
                communityId: { $in: communityIds },
                userId
            }).lean();
            const memberMap = {};
            memberships.forEach(m => { memberMap[m.communityId.toString()] = m; });

            enriched = communities.map(c => ({
                ...c,
                membership: memberMap[c._id.toString()] || null,
                isJoined: !!(memberMap[c._id.toString()] && memberMap[c._id.toString()].status === 'ACTIVE'),
                isPending: !!(memberMap[c._id.toString()] && memberMap[c._id.toString()].status === 'PENDING'),
                isOwner: c.ownerId?._id?.toString() === userId || c.ownerId?.toString() === userId
            }));
        } else {
            enriched = communities.map(c => ({
                ...c,
                membership: null,
                isJoined: false,
                isPending: false,
                isOwner: false
            }));
        }

        return res.json({
            communities: enriched,
            nextCursor: hasMore ? communities[communities.length - 1]._id : null
        });
    } catch (error) {
        console.error('searchCommunities error:', error);
        return res.status(500).json({ error: 'Failed to search communities' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/joined — Communities the user has joined
// ═══════════════════════════════════════════════════
export const getJoinedCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const memberships = await CommunityMember.find({
            userId,
            status: { $in: ['ACTIVE', 'PENDING'] }
        }).sort({ joinedAt: -1 }).lean();

        if (memberships.length === 0) {
            return res.json({ communities: [] });
        }

        const communityIds = memberships.map(m => m.communityId);
        const communities = await Community.find({ _id: { $in: communityIds } })
            .populate('ownerId', 'userName channelName channelPicture channelHandle')
            .lean();

        const communityMap = {};
        communities.forEach(c => { communityMap[c._id.toString()] = c; });

        const result = memberships
            .map(m => {
                const c = communityMap[m.communityId.toString()];
                if (!c) return null;
                return {
                    ...c,
                    membership: m,
                    memberRole: m.role,
                    memberStatus: m.status,
                    isOwner: c.ownerId?._id?.toString() === userId || c.ownerId?.toString() === userId
                };
            })
            .filter(Boolean);

        return res.json({ communities: result });
    } catch (error) {
        console.error('getJoinedCommunities error:', error);
        return res.status(500).json({ error: 'Failed to get joined communities' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/unban/:targetUserId — Unban a member
// ═══════════════════════════════════════════════════
export const unbanMember = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, targetUserId } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only owners and admins can unban members' });
        }

        const targetMember = await CommunityMember.findOne({
            communityId: id,
            userId: targetUserId,
            status: 'BANNED'
        });

        if (!targetMember) {
            return res.status(404).json({ error: 'Banned member not found' });
        }

        targetMember.role = 'MEMBER';
        targetMember.status = 'ACTIVE';
        targetMember.bannedAt = null;
        targetMember.bannedBy = null;
        targetMember.banReason = null;
        targetMember.banExpiresAt = null;
        await targetMember.save();

        await Community.findByIdAndUpdate(id, { $inc: { memberCount: 1 } });
        await logAction(userId, id, 'member_unbanned', { unbannedUserId: targetUserId });

        return res.json({ message: 'Member unbanned', membership: targetMember });
    } catch (error) {
        console.error('unbanMember error:', error);
        return res.status(500).json({ error: 'Failed to unban member' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/banned — List banned members
// ═══════════════════════════════════════════════════
export const listBannedMembers = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const banned = await CommunityMember.find({
            communityId: id,
            status: 'BANNED'
        })
            .sort({ bannedAt: -1 })
            .populate('userId', 'userName channelName channelPicture channelHandle')
            .populate('bannedBy', 'userName channelName')
            .lean();

        return res.json({ banned });
    } catch (error) {
        console.error('listBannedMembers error:', error);
        return res.status(500).json({ error: 'Failed to list banned members' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/role/:targetUserId — Change member role
// ═══════════════════════════════════════════════════
// Role change rules from spec:
// OWNER → Can assign ADMIN, MODERATOR; can demote ADMIN → MOD/MEMBER, MODERATOR → MEMBER
// ADMIN → Can assign MODERATOR; can demote MODERATOR → MEMBER
// MODERATOR/MEMBER → Cannot assign roles
export const changeRole = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, targetUserId } = req.params;
        const { newRole } = req.body;

        if (!newRole || !['ADMIN', 'MODERATOR', 'MEMBER'].includes(newRole)) {
            return res.status(400).json({ error: 'newRole must be ADMIN, MODERATOR, or MEMBER' });
        }

        // Can't change own role
        if (userId === targetUserId) {
            return res.status(400).json({ error: 'Cannot change your own role' });
        }

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE'
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not an active member' });
        }

        const roleHierarchy = { OWNER: 4, ADMIN: 3, MODERATOR: 2, MEMBER: 1, PENDING: 0, BANNED: -1 };

        // Only OWNER and ADMIN can change roles
        if (!['OWNER', 'ADMIN'].includes(callerMember.role)) {
            return res.status(403).json({ error: 'Only owner and admins can change roles' });
        }

        const targetMember = await CommunityMember.findOne({
            communityId: id,
            userId: targetUserId,
            status: 'ACTIVE'
        });

        if (!targetMember) {
            return res.status(404).json({ error: 'Active member not found' });
        }

        // Cannot modify OWNER role
        if (targetMember.role === 'OWNER') {
            return res.status(403).json({ error: 'Cannot change the owner\'s role. Use transfer ownership instead.' });
        }

        // ADMIN restrictions: can only promote MEMBER → MODERATOR or demote MODERATOR → MEMBER
        if (callerMember.role === 'ADMIN') {
            if (newRole === 'ADMIN') {
                return res.status(403).json({ error: 'Only the owner can promote to ADMIN' });
            }
            // ADMIN can't modify other ADMINs
            if (targetMember.role === 'ADMIN') {
                return res.status(403).json({ error: 'Only the owner can modify admin roles' });
            }
        }

        // Prevent promoting to a role >= caller's role (except OWNER promoting to ADMIN)
        if (callerMember.role !== 'OWNER' && roleHierarchy[newRole] >= roleHierarchy[callerMember.role]) {
            return res.status(403).json({ error: 'Cannot promote to a role equal to or above your own' });
        }

        const oldRole = targetMember.role;
        targetMember.role = newRole;
        await targetMember.save();

        await logAction(userId, id, 'role_changed', {
            targetUserId,
            oldRole,
            newRole
        });

        return res.json({
            message: `Role changed from ${oldRole} to ${newRole}`,
            membership: targetMember
        });
    } catch (error) {
        console.error('changeRole error:', error);
        return res.status(500).json({ error: 'Failed to change role' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/transfer — Transfer ownership
// ═══════════════════════════════════════════════════
export const transferOwnership = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        const { newOwnerId } = req.body;

        if (!newOwnerId) {
            return res.status(400).json({ error: 'newOwnerId is required' });
        }

        // Verify caller is OWNER
        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            role: 'OWNER',
            status: 'ACTIVE'
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only the owner can transfer ownership' });
        }

        // Target must be an ACTIVE ADMIN
        const targetMember = await CommunityMember.findOne({
            communityId: id,
            userId: newOwnerId,
            role: 'ADMIN',
            status: 'ACTIVE'
        });

        if (!targetMember) {
            return res.status(400).json({ error: 'New owner must be an active ADMIN of this community' });
        }

        // Promote target to OWNER
        targetMember.role = 'OWNER';
        await targetMember.save();

        // Demote current owner to ADMIN
        await CommunityMember.findOneAndUpdate(
            { communityId: id, userId, role: 'OWNER' },
            { role: 'ADMIN' }
        );

        // Update community ownerId
        await Community.findByIdAndUpdate(id, { ownerId: newOwnerId });

        await logAction(userId, id, 'ownership_transferred', { oldOwnerId: userId, newOwnerId });

        return res.json({ message: 'Ownership transferred successfully' });
    } catch (error) {
        console.error('transferOwnership error:', error);
        return res.status(500).json({ error: 'Failed to transfer ownership' });
    }
};

// ═══════════════════════════════════════════════════
// PUT /api/v2/communities/:id/rules — Update community rules
// ═══════════════════════════════════════════════════
export const updateRules = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        const { rules } = req.body; // Array of { title, description }

        if (!Array.isArray(rules)) {
            return res.status(400).json({ error: 'rules must be an array of { title, description }' });
        }

        if (rules.length > 20) {
            return res.status(400).json({ error: 'Maximum 20 rules allowed' });
        }

        // Only OWNER and ADMIN can manage rules
        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only owners and admins can manage community rules' });
        }

        // Validate rules
        const sanitizedRules = rules.map((r, i) => ({
            title: (r.title || `Rule ${i + 1}`).substring(0, 200),
            description: (r.description || '').substring(0, 1000)
        }));

        const community = await Community.findByIdAndUpdate(
            id,
            { rules: sanitizedRules },
            { new: true }
        ).select('rules');

        await logAction(userId, id, 'rules_updated', { ruleCount: sanitizedRules.length });

        return res.json({ rules: community.rules });
    } catch (error) {
        console.error('updateRules error:', error);
        return res.status(500).json({ error: 'Failed to update rules' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/rules — Get community rules
// ═══════════════════════════════════════════════════
export const getRules = async (req, res) => {
    try {
        const { id } = req.params;
        const community = await Community.findById(id).select('rules name').lean();
        if (!community) return res.status(404).json({ error: 'Community not found' });
        return res.json({ rules: community.rules || [], communityName: community.name });
    } catch (error) {
        console.error('getRules error:', error);
        return res.status(500).json({ error: 'Failed to get rules' });
    }
};

// Export helpers for use in other controllers
export { checkPostingAuth, logAction };

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/remove/:targetUserId — Remove a member
// ═══════════════════════════════════════════════════
export const removeMember = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id, targetUserId } = req.params;

        if (userId === targetUserId) {
            return res.status(400).json({ error: 'Cannot remove yourself. Use leave instead.' });
        }

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Not authorized to remove members' });
        }

        const targetMember = await CommunityMember.findOne({
            communityId: id,
            userId: targetUserId
        });

        if (!targetMember) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const roleHierarchy = { OWNER: 4, ADMIN: 3, MODERATOR: 2, MEMBER: 1, PENDING: 0, BANNED: -1 };
        if (roleHierarchy[targetMember.role] >= roleHierarchy[callerMember.role]) {
            return res.status(403).json({ error: 'Cannot remove a member with equal or higher role' });
        }

        await CommunityMember.deleteOne({ _id: targetMember._id });
        if (targetMember.status === 'ACTIVE') {
            await Community.findByIdAndUpdate(id, { $inc: { memberCount: -1 } });
        }

        await logAction(userId, id, 'member_removed', { removedUserId: targetUserId, removedRole: targetMember.role });

        return res.json({ message: 'Member removed' });
    } catch (error) {
        console.error('removeMember error:', error);
        return res.status(500).json({ error: 'Failed to remove member' });
    }
};

// ═══════════════════════════════════════════════════
// PUT /api/v2/communities/:id/settings — Update detailed community settings
// ═══════════════════════════════════════════════════
// OWNER can update ALL settings. ADMIN can update limited settings.
export const updateCommunitySettings = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN'] }
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only owners and admins can update settings' });
        }

        const updates = {};
        const {
            name, description, avatarUrl, bannerUrl,
            isSearchVisible, postingPolicy, type,
            importedVisibility
        } = req.body;

        // Both OWNER and ADMIN can update these:
        if (description !== undefined) updates.description = description;
        if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
        if (bannerUrl !== undefined) updates.bannerUrl = bannerUrl;

        // ADMIN can update rules and posting policy
        if (postingPolicy !== undefined) {
            if (!['ANY_MEMBER', 'ADMINS_ONLY', 'MODS_AND_ADMINS', 'OWNER_ONLY'].includes(postingPolicy)) {
                return res.status(400).json({ error: 'Invalid posting policy' });
            }
            updates.postingPolicy = postingPolicy;
        }

        // OWNER-only settings
        if (callerMember.role === 'OWNER') {
            if (name !== undefined) {
                updates.name = name;
                updates.slug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 120);
                const existingSlug = await Community.findOne({ slug: updates.slug, _id: { $ne: id } }).lean();
                if (existingSlug) updates.slug = `${updates.slug}-${Date.now().toString(36)}`;
            }
            if (type !== undefined) {
                if (!['PUBLIC', 'PRIVATE'].includes(type)) {
                    return res.status(400).json({ error: 'Type must be PUBLIC or PRIVATE' });
                }
                updates.type = type;
            }
            if (isSearchVisible !== undefined) updates.isSearchVisible = !!isSearchVisible;
            if (importedVisibility !== undefined) {
                if (!['VISIBLE_TO_ALL', 'MEMBERS_ONLY', 'NO_BACKFILL'].includes(importedVisibility)) {
                    return res.status(400).json({ error: 'Invalid importedVisibility value' });
                }
                updates.importedVisibility = importedVisibility;
            }
        } else {
            // ADMIN tried to change OWNER-only fields
            if (type !== undefined) return res.status(403).json({ error: 'Only the owner can change community type' });
            if (name !== undefined) return res.status(403).json({ error: 'Only the owner can change community name' });
            if (isSearchVisible !== undefined) return res.status(403).json({ error: 'Only the owner can change search visibility' });
            if (importedVisibility !== undefined) return res.status(403).json({ error: 'Only the owner can change import visibility' });
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const community = await Community.findByIdAndUpdate(id, { $set: updates }, { new: true })
            .populate('ownerId', 'userName channelName channelPicture channelHandle');

        await logAction(userId, id, 'settings_updated', updates);

        return res.json({ community });
    } catch (error) {
        console.error('updateCommunitySettings error:', error);
        return res.status(500).json({ error: 'Failed to update settings' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/reimport — Re-import channel content
// ═══════════════════════════════════════════════════
export const reimportChannelContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        const { importedVisibility = 'VISIBLE_TO_ALL' } = req.body;

        const callerMember = await CommunityMember.findOne({
            communityId: id,
            userId,
            role: 'OWNER',
            status: 'ACTIVE'
        }).lean();

        if (!callerMember) {
            return res.status(403).json({ error: 'Only the owner can re-import content' });
        }

        if (!['VISIBLE_TO_ALL', 'MEMBERS_ONLY', 'NO_BACKFILL'].includes(importedVisibility)) {
            return res.status(400).json({ error: 'Invalid importedVisibility' });
        }

        // Get all channel content
        const channelContents = await Content.find({
            userId,
            contentType: { $in: ['video', 'short', 'audio', 'post'] },
            status: { $in: ['completed', 'uploading'] },
            visibility: { $ne: 'private' }
        }).select('_id').lean();

        // Get existing links to avoid duplicates
        const existingLinks = await ContentToCommunity.find({
            communityId: id,
            contentId: { $in: channelContents.map(c => c._id) }
        }).select('contentId').lean();
        const existingSet = new Set(existingLinks.map(l => l.contentId.toString()));

        const newContents = channelContents.filter(c => !existingSet.has(c._id.toString()));

        if (newContents.length > 0) {
            const links = newContents.map(c => ({
                contentId: c._id,
                communityId: id,
                isImported: true,
                createdAt: new Date()
            }));
            await ContentToCommunity.insertMany(links, { ordered: false }).catch(() => { });
        }

        // Create import event
        const CommunityImportEvent = (await import('../../models/communityImportEvent.model.js')).default;
        const importEvent = await CommunityImportEvent.create({
            communityId: id,
            importedByUserId: userId,
            importedAt: new Date(),
            importedCount: newContents.length,
            visibility: importedVisibility,
            status: 'completed'
        });

        await Community.findByIdAndUpdate(id, {
            importedContentFlag: true,
            importedVisibility,
            importEventId: importEvent._id,
            importedAt: new Date(),
            $inc: { contentCount: newContents.length }
        });

        await logAction(userId, id, 'content_reimported', { newCount: newContents.length, totalChannel: channelContents.length });

        return res.json({
            message: `Re-imported ${newContents.length} new content items`,
            newCount: newContents.length,
            skippedCount: channelContents.length - newContents.length,
            totalChannelContent: channelContents.length
        });
    } catch (error) {
        console.error('reimportChannelContent error:', error);
        return res.status(500).json({ error: 'Failed to re-import content' });
    }
};
