import Content from '../models/content.model.js';
import Purchase from '../models/purchase.model.js';

const payPerViewAccess = async (req, res, next) => {
  try {
    const contentId = req.params.contentId || req.body.contentId;
    if (!contentId) {
      return next();
    }

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // If it's not pay-per-view, skip
    if (content.visibility !== 'pay_per_view') {
      return next();
    }
    
    // If user is not authenticated, they can't access pay-per-view
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required for pay-per-view content' });
    }
    
    // Allow creator to access their own content
    if (content.userId.toString() === req.user.id) {
        return next();
    }

    // Check if user has an active purchase
    const purchase = await Purchase.findOne({
      contentId,
      buyerId: req.user.id,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (!purchase) {
      return res.status(403).json({
        error: 'Purchase required',
        price: content.price,
        contentId: content._id
      });
    }

    // Attach purchase to request and proceed
    req.purchase = purchase;
    next();
  } catch (error) {
    console.error('Error in payPerViewAccess middleware:', error);
    res.status(500).json({ error: 'Server error checking content access' });
  }
};

export default payPerViewAccess;
