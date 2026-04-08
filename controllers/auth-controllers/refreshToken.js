import User from "../../models/user.model.js";
import { setAuthCookies, verifyRefreshToken } from "./services/cookieHelper.js";

/**
 * POST /api/v1/auth/authRoutes/refresh
 *
 * Reads the refresh_token cookie, verifies it, checks tokenVersion,
 * and issues a fresh pair of access + refresh cookies.
 */
export const refreshToken = async (req, res) => {
    try {
        const token = req.cookies?.refresh_token;

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No refresh token",
            });
        }

        // Decode without full verification first to get userId
        let decoded;
        try {
            const jwt = await import("jsonwebtoken");
            decoded = jwt.default.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            const reason =
                err.name === "TokenExpiredError"
                    ? "Refresh token expired"
                    : "Invalid refresh token";
            return res.status(401).json({ success: false, message: reason });
        }

        if (!decoded?.userId) {
            return res.status(401).json({
                success: false,
                message: "Invalid refresh token",
            });
        }

        // Fetch user to compare tokenVersion
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User not found",
            });
        }

        // Verify tokenVersion matches (detects password change / logout-all)
        const result = verifyRefreshToken(token, user);
        if (!result.valid) {
            return res.status(401).json({
                success: false,
                message: result.reason,
            });
        }

        // Issue fresh cookie pair (token rotation)
        setAuthCookies(res, user);

        return res.status(200).json({
            success: true,
            message: "Token refreshed",
        });
    } catch (error) {
        console.error("Refresh token error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
        });
    }
};
