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

        const community = await Community.findById(id)
            .populate('ownerId', 'userName channelName channelPicture channelHandle')
            .lean();

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
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
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

        targetMember.status = 'BANNED';
        targetMember.role = 'BANNED';
        await targetMember.save();

        await Community.findByIdAndUpdate(id, { $inc: { memberCount: -1 } });
        await logAction(userId, id, 'member_banned', { bannedUserId: targetUserId });

        return res.json({ message: 'Member banned' });
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
        const { status = 'ACTIVE', page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const members = await CommunityMember.find({
            communityId: id,
            status
        })
            .sort({ joinedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('userId', 'userName channelName channelPicture channelHandle')
            .lean();

        const total = await CommunityMember.countDocuments({ communityId: id, status });

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

// Export helpers for use in other controllers
export { checkPostingAuth, logAction };
