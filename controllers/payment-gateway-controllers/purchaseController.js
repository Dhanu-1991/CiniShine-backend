import Purchase from "../../models/purchase.model.js";
import Content from "../../models/content.model.js";

export const checkAccess = async (req, res) => {
  try {
    const { contentId } = req.params;
    const userId = req.user.id;

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
        purchase,
        expiresIn
      });
    }

    return res.status(200).json({
      success: true,
      hasAccess: false
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
      .populate('contentId', 'title thumbnailUrl contentType')
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
    const totalRevenue = purchases.reduce((sum, p) => sum + p.amount, 0);

    res.status(200).json({
      success: true,
      totalPurchases: purchases.length,
      totalRevenue,
      purchases
    });
  } catch (error) {
    console.error("Error getting content revenue:", error);
    res.status(500).json({ error: "Failed to fetch revenue data" });
  }
};
