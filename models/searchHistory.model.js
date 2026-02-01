import mongoose from 'mongoose';

/**
 * Search History Model
 * Stores user search queries for:
 * 1. Personalized search suggestions
 * 2. Search analytics and trending searches
 */
const SearchHistorySchema = new mongoose.Schema({
    // User who performed the search (optional - also track anonymous searches)
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },

    // The search query text
    query: {
        type: String,
        required: true,
        trim: true,
        index: true
    },

    // Normalized query for better matching (lowercase, trimmed)
    normalizedQuery: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        index: true
    },

    // Number of times this exact query was searched
    searchCount: {
        type: Number,
        default: 1
    },

    // Global search count (across all users)
    globalSearchCount: {
        type: Number,
        default: 1
    },

    // Last time this query was searched
    lastSearchedAt: {
        type: Date,
        default: Date.now,
        index: true
    },

    // First time this query was searched
    createdAt: {
        type: Date,
        default: Date.now
    },

    // Did user click on results after searching?
    clickedResults: {
        type: Boolean,
        default: false
    },

    // Number of results found for this query
    resultsCount: {
        type: Number,
        default: 0
    }
});

// Compound indexes for efficient queries
SearchHistorySchema.index({ userId: 1, normalizedQuery: 1 }, { unique: true, sparse: true });
SearchHistorySchema.index({ normalizedQuery: 1, globalSearchCount: -1 });
SearchHistorySchema.index({ lastSearchedAt: -1 });

// Static method to record a search
SearchHistorySchema.statics.recordSearch = async function (userId, query, resultsCount = 0) {
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.length < 2) return null;

    try {
        // Update user's personal search history
        if (userId) {
            await this.findOneAndUpdate(
                { userId, normalizedQuery },
                {
                    $set: {
                        query: query.trim(),
                        lastSearchedAt: new Date(),
                        resultsCount
                    },
                    $inc: { searchCount: 1 },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true, new: true }
            );
        }

        // Update global search count (track popular searches)
        await this.findOneAndUpdate(
            { userId: null, normalizedQuery },
            {
                $set: {
                    query: query.trim(),
                    lastSearchedAt: new Date()
                },
                $inc: { globalSearchCount: 1 },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        return true;
    } catch (error) {
        console.error('Error recording search:', error);
        return false;
    }
};

// Static method to get search suggestions based on partial query
SearchHistorySchema.statics.getSuggestions = async function (partialQuery, userId = null, limit = 10) {
    const normalizedPartial = partialQuery.trim().toLowerCase();

    if (normalizedPartial.length < 1) return [];

    try {
        // Create regex for prefix matching
        const regex = new RegExp(`^${normalizedPartial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

        // Get user's recent searches first
        let userSuggestions = [];
        if (userId) {
            userSuggestions = await this.find({
                userId,
                normalizedQuery: regex
            })
                .sort({ lastSearchedAt: -1 })
                .limit(5)
                .select('query searchCount -_id')
                .lean();
        }

        // Get popular global searches
        const globalSuggestions = await this.find({
            userId: null,
            normalizedQuery: regex
        })
            .sort({ globalSearchCount: -1, lastSearchedAt: -1 })
            .limit(limit)
            .select('query globalSearchCount -_id')
            .lean();

        // Merge and deduplicate, prioritizing user's own searches
        const seen = new Set();
        const merged = [];

        // Add user searches first (marked as personal)
        for (const s of userSuggestions) {
            const key = s.query.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ query: s.query, type: 'recent', count: s.searchCount });
            }
        }

        // Add popular searches
        for (const s of globalSuggestions) {
            const key = s.query.toLowerCase();
            if (!seen.has(key) && merged.length < limit) {
                seen.add(key);
                merged.push({ query: s.query, type: 'popular', count: s.globalSearchCount });
            }
        }

        return merged.slice(0, limit);
    } catch (error) {
        console.error('Error getting search suggestions:', error);
        return [];
    }
};

// Static method to get user's recent searches
SearchHistorySchema.statics.getRecentSearches = async function (userId, limit = 10) {
    if (!userId) return [];

    try {
        return await this.find({ userId })
            .sort({ lastSearchedAt: -1 })
            .limit(limit)
            .select('query lastSearchedAt -_id')
            .lean();
    } catch (error) {
        console.error('Error getting recent searches:', error);
        return [];
    }
};

// Static method to get trending searches (global)
SearchHistorySchema.statics.getTrendingSearches = async function (limit = 10, timeframeDays = 7) {
    try {
        const cutoffDate = new Date(Date.now() - timeframeDays * 24 * 60 * 60 * 1000);

        return await this.find({
            userId: null,
            lastSearchedAt: { $gte: cutoffDate }
        })
            .sort({ globalSearchCount: -1 })
            .limit(limit)
            .select('query globalSearchCount -_id')
            .lean();
    } catch (error) {
        console.error('Error getting trending searches:', error);
        return [];
    }
};

// Static method to delete user's search history
SearchHistorySchema.statics.clearUserHistory = async function (userId) {
    if (!userId) return false;

    try {
        await this.deleteMany({ userId });
        return true;
    } catch (error) {
        console.error('Error clearing search history:', error);
        return false;
    }
};

const SearchHistory = mongoose.model('SearchHistory', SearchHistorySchema);

export default SearchHistory;
