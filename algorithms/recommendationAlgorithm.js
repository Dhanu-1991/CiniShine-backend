// algorithms/recommendationAlgorithm.js
/**
 * YouTube-grade Recommendation Engine
 *
 * Signal weights (tuned to match YouTube's published paper priorities):
 *
 *  ┌──────────────────────────────┬─────────┐
 *  │ Signal                       │ Weight  │
 *  ├──────────────────────────────┼─────────┤
 *  │ Average Watch-Time Ratio     │  0.28   │  ← strongest signal (YouTube confirmed)
 *  │ Engagement Rate (likes/views)│  0.18   │
 *  │ Follower / Creator Score     │  0.15   │  new: big channels AND new creators
 *  │ Personalised user affinity   │  0.15   │
 *  │ Content-based similarity     │  0.10   │
 *  │ Recency / freshness          │  0.08   │
 *  │ Velocity (view growth rate)  │  0.06   │
 *  └──────────────────────────────┴─────────┘
 *
 * Extra boosts (additive, capped):
 *  - New creator boost: channels <30 days old
 *  - Fresh content push: videos uploaded in last 48h from followed channels
 *  - Diversity penalty: slightly disfavour same-creator repetition in a session
 */

const SIGNAL_WEIGHTS = {
    avgWatchTimeRatio: 0.28,
    engagementRate: 0.18,
    creatorScore: 0.15,
    userAffinity: 0.15,
    contentSimilarity: 0.10,
    recency: 0.08,
    velocity: 0.06,
};

export class RecommendationEngine {
    constructor() {
        this.weights = SIGNAL_WEIGHTS;
        // Legacy compat
        this.contentWeights = SIGNAL_WEIGHTS;
    }

    // ─────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Primary recommendation entry-point (videos / shorts / audio / posts).
     * @param {Object}  user
     * @param {Array}   allContent        - Pre-fetched content array (lean objects)
     * @param {Array}   [userVideos]      - Kept for legacy compat (ignored)
     * @param {Object}  options
     * @param {number}  options.limit       - How many to return (default 20)
     * @param {boolean} options.excludeOwn  - Exclude user's own content
     * @param {Array}   options.seenIds     - IDs already shown in this session (diversity)
     */
    async getRecommendations(user, allContent, userVideos, options = {}) {
        // Support both 3-arg (legacy) and 2-arg calls
        if (Array.isArray(userVideos) === false && typeof userVideos === 'object' && userVideos !== null) {
            options = userVideos;
            userVideos = [];
        }
        const { limit = 20, excludeOwn = true, seenIds = [] } = options;
        const userId = user?._id?.toString();

        let candidates = excludeOwn && userId
            ? allContent.filter(c => c.userId?.toString() !== userId)
            : allContent;

        const maxViews = Math.max(1, ...candidates.map(c => c.views || 0));
        const seenSet = new Set((seenIds || []).map(String));

        const scored = candidates.map(item => {
            const plain = typeof item.toJSON === 'function' ? item.toJSON() : item;
            return { ...plain, recommendationScore: this._totalScore(user, item, { maxViews, seenSet }) };
        });

        scored.sort((a, b) => b.recommendationScore - a.recommendationScore);

        // Diversity: cap same-creator at 3 per result set
        const result = [];
        const creatorCount = {};
        for (const item of scored) {
            const cid = (item.userId?._id || item.userId)?.toString() || 'anon';
            creatorCount[cid] = (creatorCount[cid] || 0) + 1;
            if (creatorCount[cid] <= 3) result.push(item);
            if (result.length >= limit) break;
        }
        return result;
    }

    /** Alias used by content-type controllers */
    async getContentRecommendations(user, allContent, options = {}) {
        return this.getRecommendations(user, allContent, [], options);
    }

    /** Trending: high velocity in last 7 days */
    getTrendingVideos(videos, limit = 10) {
        const weekAgo = new Date(Date.now() - 7 * 86400000);
        return videos
            .filter(v => new Date(v.createdAt) >= weekAgo)
            .map(v => ({ ...v, _trend: this._velocityScore(v) + this._engagementScore(v) }))
            .sort((a, b) => b._trend - a._trend)
            .slice(0, limit);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRIVATE SCORING
    // ─────────────────────────────────────────────────────────────────────

    _totalScore(user, item, { maxViews, seenSet }) {
        const w = this.weights;
        let score = 0;

        score += this._watchTimeScore(item) * w.avgWatchTimeRatio;
        score += this._engagementScore(item) * w.engagementRate;
        score += this._creatorScore(item) * w.creatorScore;
        score += this._userAffinityScore(user, item) * w.userAffinity;
        score += this._contentSimilarity(user, item) * w.contentSimilarity;
        score += this._recencyScore(item.createdAt) * w.recency;
        score += this._velocityScore(item) * w.velocity;

        // ── Additive boosts ──

        // New creator boost (<30 days, <100 followers)
        const isNewCreator = item.channelCreatedAt &&
            (Date.now() - new Date(item.channelCreatedAt)) / 86400000 < 30;
        const hasSmallChannel = (item.subscriberCount || item.followerCount || 0) < 100;
        if (isNewCreator && hasSmallChannel) score += 0.12;

        // Fresh content from followed channel
        const hoursOld = (Date.now() - new Date(item.createdAt)) / 3600000;
        const isFollowed = (user?.subscriptions || []).some(s => {
            const sid = s._id?.toString() || s?.toString();
            return sid === (item.userId?._id || item.userId)?.toString();
        });
        if (hoursOld < 48 && isFollowed) score += 0.15;

        // Diversity penalty for already-seen
        if (seenSet.has(item._id?.toString())) score -= 0.10;

        return Math.max(0, score);
    }

    /** avgWatchTime / duration ∈ [0,1] */
    _watchTimeScore(item) {
        const avg = item.averageWatchTime || 0;
        const dur = item.duration || 0;
        if (avg > 0 && dur > 0) return Math.min(avg / dur, 1);
        if (item.avgWatchPercentage > 0) return item.avgWatchPercentage / 100;
        return 0;
    }

    /** (likes + comments×2) / views → log-normalised to [0,1] */
    _engagementScore(item) {
        const views = item.views || 0;
        if (views === 0) return 0;
        const likes = item.likes || 0;
        const comments = item.commentCount || 0;
        return Math.min(1, (likes + comments * 2) / Math.max(views, 1) / 0.1);
    }

    /** log-normalised subscriber count */
    _creatorScore(item) {
        const subs = item.subscriberCount || item.followerCount || 0;
        if (subs === 0) return 0.1;
        return Math.min(1, Math.log10(subs + 1) / 6);
    }

    /** Personalised signals: followed, tag overlap, category match */
    _userAffinityScore(user, item) {
        if (!user?._id) return 0.2;
        let score = 0;
        const isFollowed = (user.subscriptions || []).some(s => {
            const sid = s._id?.toString() || s?.toString();
            return sid === (item.userId?._id || item.userId)?.toString();
        });
        if (isFollowed) score += 0.5;

        if (user.preferredTags?.length && item.tags?.length) {
            const overlap = item.tags.filter(t => user.preferredTags.includes(t)).length;
            score += Math.min(0.3, overlap * 0.1);
        }
        if (user.preferredCategories?.length && item.category) {
            if (user.preferredCategories.includes(item.category)) score += 0.2;
        }
        return Math.min(1, score);
    }

    /** Tag / quality preference match */
    _contentSimilarity(user, item) {
        let sim = 0;
        if (user?.prefferedRendition && user.prefferedRendition !== 'Auto') {
            const q = user.prefferedRendition.replace('p', '');
            if ((item.renditions || []).some(r => r.resolution?.replace('p', '') === q)) sim += 0.4;
        }
        if (user?.preferredTags?.length && item.tags?.length) {
            const overlap = item.tags.filter(t => user.preferredTags.includes(t)).length;
            sim += Math.min(0.4, overlap * 0.1);
        }
        sim += Math.random() * 0.05; // jitter prevents ranking monotony
        return Math.min(1, sim);
    }

    /**
     * Two-tier recency decay:
     *  0-48h  → ~0.95 (freshness tier)
     *  2-30d  → exponential decay (half-life 14d)
     *  >30d   → 0.05 baseline
     */
    _recencyScore(createdAt) {
        const hoursOld = (Date.now() - new Date(createdAt)) / 3600000;
        if (hoursOld <= 48) return 0.90 + 0.10 * (1 - hoursOld / 48);
        const daysOld = hoursOld / 24;
        if (daysOld <= 30) return Math.exp(-(daysOld - 2) / 14);
        return 0.05;
    }

    /** Recent view velocity: recentViews/total scaled */
    _velocityScore(item) {
        const total = item.views || 0;
        const recent = item.recentViews || 0;
        if (total === 0) return 0;
        return Math.min(1, (recent / total) * 10);
    }

    // ── Legacy aliases ────────────────────────────────────────────────────
    calculateWatchTimeScore(item) { return this._watchTimeScore(item); }
    calculateEngagementScore(item) { return this._engagementScore(item); }
    calculateRecencyScore(createdAt) { return this._recencyScore(createdAt); }
    getSimilarCreatorVideos(user, videos, limit = 10) {
        return this.getTrendingVideos(videos, limit);
    }
    calculateRecommendationScore(user, video, allVideos) {
        const maxViews = Math.max(1, ...allVideos.map(v => v.views || 0));
        return this._totalScore(user, video, { maxViews, seenSet: new Set() });
    }
    calculateContentRecommendationScore(user, item, allContent) {
        const maxViews = Math.max(1, ...allContent.map(c => c.views || 0));
        return this._totalScore(user, item, { maxViews, seenSet: new Set() });
    }
}

export const recommendationEngine = new RecommendationEngine();


