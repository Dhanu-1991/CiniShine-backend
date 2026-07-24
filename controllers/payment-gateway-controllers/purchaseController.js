import Purchase from "../../models/purchase.model.js";
import Content from "../../models/content.model.js";

export const checkAccess = async (req, res) => {
  try {
    const { contentId } = req.params;
    const userId = req.user.id;

    const content = await Content.findById(contentId).select('userId contentType visibility');
    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    // Creator always has full access
    const isCreator = content.userId?.toString() === userId;
    if (isCreator) {
      return res.status(200).json({
        success: true,
        hasAccess: true,
        isCreator: true,
        contentType: content.contentType
      });
    }

    const purchase = await Purchase.findOne({
      contentId,
      buyerId: userId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (purchase) {
      const expiresIn = purchase.expiresAt.getTime() - Date.now();
      return res.status(200).json({
        success: true,
        hasAccess: true,
        contentType: content.contentType,
        purchase,
        expiresIn
      });
    }

    return res.status(200).json({
      success: true,
      hasAccess: false,
      contentType: content.contentType
    });
  } catch (error) {
    console.error("Error checking purchase access:", error);
    res.status(500).json({ error: "Failed to check access" });
  }
};

export const getUserPurchases = async (req, res) => {
  try {
    const userId = req.user.id;
    const purchases = await Purchase.find({ buyerId: userId })
      .populate('contentId', 'title thumbnailKey contentType coverArtKey imageKey')
      .sort({ purchasedAt: -1 });

    res.status(200).json({
      success: true,
      purchases
    });
  } catch (error) {
    console.error("Error getting user purchases:", error);
    res.status(500).json({ error: "Failed to fetch purchases" });
  }
};

export const getContentRevenue = async (req, res) => {
  try {
    const { contentId } = req.params;
    const userId = req.user.id;

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    if (content.userId.toString() !== userId) {
      return res.status(403).json({ error: "Unauthorized access to content revenue" });
    }

    const purchases = await Purchase.find({ contentId, status: 'active' });
    const totalSellingPrice = purchases.reduce((sum, p) => sum + p.amount, 0);
    const totalBasePrice = purchases.reduce((sum, p) => sum + (p.basePrice || (p.amount / 1.18)), 0);
    const totalGstCollected = purchases.reduce((sum, p) => sum + (p.gstAmount || (p.amount - p.amount / 1.18)), 0);
    const totalPlatformCommission = purchases.reduce((sum, p) => sum + (p.platformCommission || (p.amount * 0.32)), 0);
    const totalGstOnCommission = purchases.reduce((sum, p) => sum + (p.gstOnCommission || (p.amount * 0.32 * 0.18)), 0);
    const totalTdsDeducted = purchases.reduce((sum, p) => sum + (p.tdsAmount || ((p.amount / 1.18) * 0.001)), 0);
    const totalTcsDeducted = purchases.reduce((sum, p) => sum + (p.tcsAmount || ((p.amount / 1.18) * 0.01)), 0);
    const totalCreatorPayout = purchases.reduce((sum, p) => sum + (p.creatorPayout || (p.amount - (p.amount * 0.32) - (p.amount * 0.32 * 0.18) - ((p.amount / 1.18) * 0.001) - ((p.amount / 1.18) * 0.01))), 0);

    res.status(200).json({
      success: true,
      totalPurchases: purchases.length,
      totalRevenue: Number(totalSellingPrice.toFixed(2)),
      taxBreakdown: {
        totalSellingPrice: Number(totalSellingPrice.toFixed(2)),
        totalBasePrice: Number(totalBasePrice.toFixed(2)),
        totalGstCollected: Number(totalGstCollected.toFixed(2)),
        totalPlatformCommission: Number(totalPlatformCommission.toFixed(2)),
        totalGstOnCommission: Number(totalGstOnCommission.toFixed(2)),
        totalTdsDeducted: Number(totalTdsDeducted.toFixed(2)),
        totalTcsDeducted: Number(totalTcsDeducted.toFixed(2)),
        totalCreatorPayout: Number(totalCreatorPayout.toFixed(2)),
      },
      purchases
    });
  } catch (error) {
    console.error("Error getting content revenue:", error);
    res.status(500).json({ error: "Failed to fetch revenue data" });
  }
};
