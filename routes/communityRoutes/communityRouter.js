import express from 'express';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import {
    createCommunity,
    listCommunities,
    getCommunity,
    updateCommunity,
    joinCommunity,
    leaveCommunity,
    approveJoinRequest,
    rejectJoinRequest,
    banMember,
    listMembers,
    listPendingRequests,
    updatePostingPolicy,
    getUserPostableCommunities,
    clearImportedContent,
    searchCommunities,
    getJoinedCommunities
} from '../../controllers/community-controllers/communityController.js';
import {
    getCommunityFeed,
    postContentToCommunities,
    getCommunityUnreadCount,
    getImportStatus
} from '../../controllers/community-controllers/communityFeedController.js';

const router = express.Router();

// ── Feed & discovery (comes before :id routes to avoid conflicts) ──
router.get('/feed', universalTokenVerifier, getCommunityFeed);
router.get('/search', optionalTokenVerifier, searchCommunities);
router.get('/joined', universalTokenVerifier, getJoinedCommunities);
router.get('/unread-count', universalTokenVerifier, getCommunityUnreadCount);
router.get('/user-communities', universalTokenVerifier, getUserPostableCommunities);

// ── Content posting to communities ──
router.post('/content', universalTokenVerifier, postContentToCommunities);

// ── Community CRUD ──
router.post('/', universalTokenVerifier, createCommunity);
router.get('/', optionalTokenVerifier, listCommunities);
router.get('/:id', optionalTokenVerifier, getCommunity);
router.put('/:id', universalTokenVerifier, updateCommunity);

// ── Membership ──
router.post('/:id/join', universalTokenVerifier, joinCommunity);
router.post('/:id/leave', universalTokenVerifier, leaveCommunity);
router.get('/:id/members', optionalTokenVerifier, listMembers);
router.get('/:id/pending', universalTokenVerifier, listPendingRequests);
router.post('/:id/approve/:memberId', universalTokenVerifier, approveJoinRequest);
router.post('/:id/reject/:memberId', universalTokenVerifier, rejectJoinRequest);
router.post('/:id/ban/:targetUserId', universalTokenVerifier, banMember);

// ── Settings ──
router.put('/:id/posting-policy', universalTokenVerifier, updatePostingPolicy);

// ── Import management ──
router.delete('/:id/imported', universalTokenVerifier, clearImportedContent);
router.get('/:id/import-status', universalTokenVerifier, getImportStatus);

export default router;
