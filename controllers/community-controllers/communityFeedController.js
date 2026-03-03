import mongoose from 'mongoose';
import Community from '../../models/community.model.js';
import CommunityMember from '../../models/communityMember.model.js';
import ContentToCommunity from '../../models/contentToCommunity.model.js';
import Content from '../../models/content.model.js';
import ActionLog from '../../models/actionLog.model.js';
import { checkPostingAuth, logAction } from './communityController.js';

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/feed — Mixed community feed
// ═══════════════════════════════════════════════════
export const getCommunityFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const {
            filter = 'all',        // all | public | private | my_posts
            communityId,           // specific community filter
            cursor,                // cursor for pagination (contentId)
            limit = 20,
            contentType            // optional: video | short | audio | post
        } = req.query;

        const pageLimit = Math.min(parseInt(limit) || 20, 50);

        // ── Determine which communities to include ──
        let targetCommunityIds = [];

        if (communityId) {
            // Specific community
            const community = await Community.findById(communityId).lean();
            if (!community) return res.status(404).json({ error: 'Community not found' });

            if (community.type === 'PRIVATE') {
                if (!userId) return res.status(403).json({ error: 'Authentication required for private communities' });
                const membership = await CommunityMember.findOne({
                    communityId, userId, status: 'ACTIVE'
                }).lean();
                if (!membership) return res.status(403).json({ error: 'Not a member of this private community' });
            }
            targetCommunityIds = [new mongoose.Types.ObjectId(communityId)];
        } else {
            switch (filter) {
                case 'public': {
                    const publicComms = await Community.find({ type: 'PUBLIC', isSearchVisible: true })
                        .select('_id').lean();
                    targetCommunityIds = publicComms.map(c => c._id);
                    break;
                }
                case 'private': {
                    if (!userId) return res.json({ feed: [], nextCursor: null });
                    const privMemberships = await CommunityMember.find({
                        userId, status: 'ACTIVE'
                    }).select('communityId').lean();
                    const privIds = privMemberships.map(m => m.communityId);
                    const privComms = await Community.find({
                        _id: { $in: privIds }, type: 'PRIVATE'
                    }).select('_id').lean();
                    targetCommunityIds = privComms.map(c => c._id);
                    break;
                }
                default: {
                    // 'all' — communities the user is a member of + public communities
                    const allPublic = await Community.find({ type: 'PUBLIC', isSearchVisible: true })
                        .select('_id').lean();
                    targetCommunityIds = allPublic.map(c => c._id);

                    if (userId) {
                        const userMemberships = await CommunityMember.find({
                            userId, status: 'ACTIVE'
                        }).select('communityId').lean();
                        const memberIds = userMemberships.map(m => m.communityId);
                        // Merge, dedupe
                        const idSet = new Set(targetCommunityIds.map(id => id.toString()));
                        for (const mid of memberIds) {
                            if (!idSet.has(mid.toString())) {
                                targetCommunityIds.push(mid);
                                idSet.add(mid.toString());
                            }
                        }
                    }
                }
            }
        }

        if (targetCommunityIds.length === 0) {
            return res.json({ feed: [], nextCursor: null });
        }

        // ── Build content query via ContentToCommunity ──
        const ctcQuery = {
            communityId: { $in: targetCommunityIds }
        };
        if (cursor) {
            ctcQuery._id = { $lt: new mongoose.Types.ObjectId(cursor) };
        }

        // Fetch linked content IDs with community info
        const links = await ContentToCommunity.find(ctcQuery)
            .sort({ createdAt: -1 })
            .limit(pageLimit + 1)
            .lean();

        const hasMore = links.length > pageLimit;
        if (hasMore) links.pop();

        if (links.length === 0) {
            return res.json({ feed: [], nextCursor: null });
        }

        const contentIds = [...new Set(links.map(l => l.contentId.toString()))];

        // Fetch content
        const contentQuery = {
            _id: { $in: contentIds.map(id => new mongoose.Types.ObjectId(id)) }
        };
        if (contentType) {
            contentQuery.contentType = contentType;
        }

        const contents = await Content.find(contentQuery)
            .populate('userId', 'userName channelName channelPicture channelHandle')
            .lean();

        const contentMap = {};
        contents.forEach(c => { contentMap[c._id.toString()] = c; });

        // ── Get community details for enrichment ──
        const communityIds = [...new Set(links.map(l => l.communityId.toString()))];
        const communities = await Community.find({
            _id: { $in: communityIds.map(id => new mongoose.Types.ObjectId(id)) }
        }).select('name slug type importedVisibility importedAt importedContentFlag avatarUrl').lean();
        const communityMap = {};
        communities.forEach(c => { communityMap[c._id.toString()] = c; });

        // ── Get user memberships for visibility checks ──
        let membershipMap = {};
        if (userId) {
            const memberships = await CommunityMember.find({
                userId,
                communityId: { $in: communityIds.map(id => new mongoose.Types.ObjectId(id)) }
            }).lean();
            memberships.forEach(m => { membershipMap[m.communityId.toString()] = m; });
        }

        // ── Apply visibility/backfill rules ──
        const feed = [];
        for (const link of links) {
            const content = contentMap[link.contentId.toString()];
            if (!content) continue;

            const community = communityMap[link.communityId.toString()];
            if (!community) continue;

            // Skip private channel-only content
            if (content.visibility === 'private') continue;

            // Visibility checks for imported content
            if (link.isImported && community.importedContentFlag) {
                const membership = membershipMap[community._id.toString()];

                if (community.importedVisibility === 'MEMBERS_ONLY') {
                    if (!membership || membership.status !== 'ACTIVE') continue;
                }

                if (community.importedVisibility === 'NO_BACKFILL') {
                    if (!membership || membership.status !== 'ACTIVE') continue;
                    // If user joined after import, skip imported content
                    if (community.importedAt && membership.joinedAt > community.importedAt) {
                        // Allow owners/admins/mods to still see
                        if (!['OWNER', 'ADMIN', 'MODERATOR'].includes(membership.role)) {
                            continue;
                        }
                    }
                }

                // For PRIVATE communities, always require active membership
                if (community.type === 'PRIVATE') {
                    if (!membership || membership.status !== 'ACTIVE') continue;
                }
            }

            // For PRIVATE non-imported content, check membership
            if (community.type === 'PRIVATE') {
                const membership = membershipMap[community._id.toString()];
                if (!membership || membership.status !== 'ACTIVE') continue;
            }

            // Filter: my_posts
            if (filter === 'my_posts' && content.userId?._id?.toString() !== userId) continue;

            feed.push({
                ...content,
                _linkId: link._id,
                communityId: link.communityId,
                communityName: community.name,
                communitySlug: community.slug,
                communityType: community.type,
                communityAvatarUrl: community.avatarUrl,
                isImported: link.isImported
            });
        }

        return res.json({
            feed,
            nextCursor: hasMore && links.length > 0 ? links[links.length - 1]._id : null
        });
    } catch (error) {
        console.error('getCommunityFeed error:', error);
        return res.status(500).json({ error: 'Failed to get community feed' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/content — Post content to communities
// ═══════════════════════════════════════════════════
export const postContentToCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const {
            contentId,            // Existing content ID to link to communities
            postToCommunities = [] // Array of community IDs
        } = req.body;

        if (!contentId || !postToCommunities.length) {
            return res.status(400).json({ error: 'contentId and postToCommunities are required' });
        }

        // Verify content exists and belongs to user
        const content = await Content.findOne({ _id: contentId, userId }).lean();
        if (!content) {
            return res.status(404).json({ error: 'Content not found or not owned by you' });
        }

        // Validate authorization for each community
        const communities = await Community.find({
            _id: { $in: postToCommunities }
        }).lean();

        if (communities.length !== postToCommunities.length) {
            return res.status(400).json({ error: 'One or more communities not found' });
        }

        // Check posting auth for ALL communities before creating any links
        for (const community of communities) {
            const authResult = await checkPostingAuth(userId, community);
            if (!authResult.allowed) {
                return res.status(403).json({
                    error: `Not authorized to post to "${community.name}": ${authResult.reason}`
                });
            }
        }

        // Create links
        const links = postToCommunities.map(cId => ({
            contentId,
            communityId: cId,
            isImported: false,
            createdAt: new Date()
        }));

        await ContentToCommunity.insertMany(links, { ordered: false }).catch((e) => {
            // Ignore duplicate key errors (already linked)
            if (e.code !== 11000) throw e;
        });

        // Update content counts
        await Community.updateMany(
            { _id: { $in: postToCommunities } },
            { $inc: { contentCount: 1 } }
        );

        for (const community of communities) {
            await logAction(userId, community._id, 'content_posted', { contentId, contentType: content.contentType });
        }

        return res.status(201).json({
            message: 'Content posted to communities',
            linkedCommunities: postToCommunities.length
        });
    } catch (error) {
        console.error('postContentToCommunities error:', error);
        return res.status(500).json({ error: 'Failed to post content to communities' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/unread-count — Unread community content count
// ═══════════════════════════════════════════════════
export const getCommunityUnreadCount = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.json({ unreadCount: 0, pendingRequests: 0 });

        // Get user's last visit timestamp from query or use stored value
        const lastVisit = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        // Communities user is a member of
        const memberships = await CommunityMember.find({
            userId, status: 'ACTIVE'
        }).select('communityId').lean();

        const communityIds = memberships.map(m => m.communityId);

        if (communityIds.length === 0) {
            return res.json({ unreadCount: 0, pendingRequests: 0 });
        }

        // Count new content since last visit
        const unreadCount = await ContentToCommunity.countDocuments({
            communityId: { $in: communityIds },
            createdAt: { $gt: new Date(lastVisit) }
        });

        // Count pending join requests (for communities user is admin/owner of)
        const modMemberships = await CommunityMember.find({
            userId,
            status: 'ACTIVE',
            role: { $in: ['OWNER', 'ADMIN', 'MODERATOR'] }
        }).select('communityId').lean();

        let pendingRequests = 0;
        if (modMemberships.length > 0) {
            pendingRequests = await CommunityMember.countDocuments({
                communityId: { $in: modMemberships.map(m => m.communityId) },
                status: 'PENDING'
            });
        }

        return res.json({ unreadCount: Math.min(unreadCount, 99), pendingRequests });
    } catch (error) {
        console.error('getCommunityUnreadCount error:', error);
        return res.json({ unreadCount: 0, pendingRequests: 0 });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/import-status — Check import event status
// ═══════════════════════════════════════════════════
export const getImportStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { eventId } = req.query;

        const query = eventId ? { _id: eventId } : { communityId: id };
        const event = await (await import('../../models/communityImportEvent.model.js')).default
            .findOne(query)
            .sort({ importedAt: -1 })
            .lean();

        if (!event) return res.status(404).json({ error: 'Import event not found' });
        return res.json({ importEvent: event });
    } catch (error) {
        console.error('getImportStatus error:', error);
        return res.status(500).json({ error: 'Failed to get import status' });
    }
};
