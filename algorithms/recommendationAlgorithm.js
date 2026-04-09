// algorithms/recommendationAlgorithm.js
/**
 * YouTube-grade Recommendation Engine
 *
 * Signal weights (tuned for balanced content discovery):
 *
 *  ┌──────────────────────────────┬─────────┐
 *  │ Signal                       │ Weight  │
 *  ├──────────────────────────────┼─────────┤
 *  │ Average Watch-Time Ratio     │  0.22   │  ← strongest quality signal
 *  │ Engagement Rate (likes/views)│  0.15   │
 *  │ Follower / Creator Score     │  0.12   │  big channels AND new creators
 *  │ Personalised user affinity   │  0.18   │  ← boosted: subscriptions + history
 *  │ View popularity (log-norm)   │  0.10   │  content with max views
 *  │ Content-based similarity     │  0.08   │
 *  │ Recency / freshness          │  0.08   │
 *  │ Velocity (view growth rate)  │  0.05   │
 *  │ New creator space            │  0.02   │  reserved for emerging creators
 *  └──────────────────────────────┴─────────┘
 *
 * Extra boosts (additive, capped):
 *  - New creator boost: channels <30 days old, <100 followers
 *  - Fresh content push: videos uploaded in last 48h from followed channels
 *  - Diversity penalty: slightly disfavour same-creator repetition in a session
 */

const SIGNAL_WEIGHTS = {
    avgWatchTimeRatio: 0.22,
    engagementRate: 0.15,
    creatorScore: 0.12,
    userAffinity: 0.18,
    viewPopularity: 0.10,
    contentSimilarity: 0.08,
    recency: 0.08,
    velocity: 0.05,
    newCreatorSpace: 0.02,
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

    /**
     * Trending: progressive time-window fallbacks to ensure results.
     * Tries 7d → 30d → 90d → all-time, stops when >= limit results found.
     * Uses velocity + engagement for recent content, popularity + engagement for older.
     */
    getTrendingVideos(videos, limit = 10) {
        if (!videos || videos.length === 0) return [];

        const windows = [7, 30, 90, Infinity]; // days
        for (const days of windows) {
            const cutoff = days === Infinity
                ? new Date(0)
                : new Date(Date.now() - days * 86400000);
            const candidates = videos
                .filter(v => new Date(v.createdAt) >= cutoff)
                .map(v => {
                    // For wider time windows, weight popularity more since velocity is less meaningful
                    const velocityW = days <= 7 ? 0.5 : days <= 30 ? 0.3 : 0.1;
                    const engagementW = 0.4;
                    const popularityW = 1 - velocityW - engagementW;
                    const maxViews = Math.max(1, ...videos.map(c => c.views || 0));
                    const trend = (this._velocityScore(v) * velocityW)
                        + (this._engagementScore(v) * engagementW)
                        + (this._viewPopularityScore(v, maxViews) * popularityW);
                    return { ...v, _trend: trend };
                })
                .sort((a, b) => b._trend - a._trend)
                .slice(0, limit);
            if (candidates.length >= limit || days === Infinity) {
                return candidates;
            }
        }
        return [];
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
        score += this._viewPopularityScore(item, maxViews) * w.viewPopularity;
        score += this._contentSimilarity(user, item) * w.contentSimilarity;
        score += this._recencyScore(item.createdAt) * w.recency;
        score += this._velocityScore(item) * w.velocity;
        score += this._newCreatorScore(item) * w.newCreatorSpace;

        // ── Additive boosts ──

        // Fresh content from followed channel (48h window)
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

    /** View popularity: log-normalized view count against max */
    _viewPopularityScore(item, maxViews) {
        const views = item.views || 0;
        if (views === 0) return 0;
        return Math.min(1, Math.log10(views + 1) / Math.log10(maxViews + 1));
    }

    /** New creator score: channels <30 days, <100 followers get full score */
    _newCreatorScore(item) {
        const subs = item.subscriberCount || item.followerCount || 0;
        const channelCreatedAt = item.channelCreatedAt;
        if (!channelCreatedAt) return 0.3; // unknown age = partial score
        const channelAgeDays = (Date.now() - new Date(channelCreatedAt)) / 86400000;
        if (channelAgeDays < 30 && subs < 100) return 1.0;
        if (channelAgeDays < 60 && subs < 500) return 0.6;
        if (channelAgeDays < 90) return 0.3;
        return 0.1;
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


