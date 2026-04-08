import User from "../../models/user.model.js";
import { clearAuthCookies } from "./services/cookieHelper.js";

/**
 * POST /api/v1/auth/authRoutes/logout
 *
 * Clears auth cookies and increments tokenVersion
 * so the refresh token can never be reused.
 */
export const logout = async (req, res) => {
    try {
        // If user is authenticated, increment tokenVersion to invalidate refresh tokens
        const userId = req.user?.id;
        if (userId) {
            await User.findByIdAndUpdate(userId, {
                $inc: { tokenVersion: 1 },
            });
        }

        // Clear cookies
        clearAuthCookies(res);

        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
        });
    } catch (error) {
        console.error("Logout error:", error);
        // Still clear cookies even if DB update fails
        clearAuthCookies(res);
        return res.status(200).json({
            success: true,
            message: "Logged out",
        });
    }
};
