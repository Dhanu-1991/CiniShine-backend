import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Purchase from '../../models/purchase.model.js';
import WatchHistory from '../../models/watchHistory.model.js';

export const getRentalRecommendations = async (req, res) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            // Unauthenticated: return top 20 PPV content sorted by viewCount
            const topContent = await Content.find({
                price: { $gt: 0 },
                status: 'completed',
                visibility: 'pay_per_view',
                contentType: { $in: ['video', 'audio'] },
            }).sort({ views: -1 }).limit(20);
            
            return res.status(200).json(topContent.map(c => ({ ...c.toObject(), ppvPrice: c.price })));
        }

        // 1. Get already purchased content to exclude
        const activePurchases = await Purchase.find({
            buyerId: userId
        });
        const purchasedIds = activePurchases.map(p => p.contentId);

        // 2. Read user's recent watch history (last 50 entries)
        const history = await WatchHistory.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(userId) } },
            { $sort: { lastWatchedAt: -1 } },
            { $limit: 50 },
            {
                $lookup: {
                    from: 'contents', // Mongoose default collection name for 'Content'
                    localField: 'contentId',
                    foreignField: '_id',
                    as: 'contentInfo'
                }
            },
            { $unwind: '$contentInfo' }
        ]);

        // 3. Extract category and tags and 4. Count frequency
        const categoryFreq = {};
        const tagFreq = {};
        
        for (const item of history) {
            const cat = item.contentInfo.category;
            if (cat) {
                categoryFreq[cat] = (categoryFreq[cat] || 0) + 1;
            }
            const tags = item.contentInfo.tags || [];
            for (const tag of tags) {
                if (tag) {
                    tagFreq[tag] = (tagFreq[tag] || 0) + 1;
                }
            }
        }

        // 5. Query Content model for PPV items (video and audio only)
        const candidates = await Content.find({
            price: { $gt: 0 },
            status: 'completed',
            visibility: 'pay_per_view',
            contentType: { $in: ['video', 'audio'] },
            _id: { $nin: purchasedIds }
        });

        // 6. Score each result
        const scored = candidates.map(content => {
            let score = 0;
            const contentCat = content.category;
            if (contentCat && categoryFreq[contentCat]) {
                score += 3 * categoryFreq[contentCat];
            }
            const contentTags = content.tags || [];
            for (const tag of contentTags) {
                if (tag && tagFreq[tag]) {
                    score += 1 * tagFreq[tag];
                }
            }
            
            return {
                ...content.toObject(),
                ppvPrice: content.price,
                score
            };
        });

        // 7. Sort by score DESC, then by viewCount DESC
        scored.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return (b.views || 0) - (a.views || 0);
        });

        // 8. Return top 20
        const top20 = scored.slice(0, 20);
        return res.status(200).json(top20);

    } catch (error) {
        console.error('[RentalRec] Error getting rental recommendations:', error);
        return res.status(500).json({ error: 'Failed to get rental recommendations' });
    }
};
