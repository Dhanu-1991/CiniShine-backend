import User from "../../models/user.model.js";
import { tokenVerifier } from "../auth-controllers/tokenverifier.js";

export const getRoles = async (req, res) => {
    try {
        // --- Verify Token ---
        const tokenResponse = await tokenVerifier(req);

        if (!tokenResponse || typeof tokenResponse.status !== "number") {
            return res.status(401).json({ message: "Invalid token response" });
        }

        if (tokenResponse.status !== 200) {
            return res.status(tokenResponse.status).json({ message: tokenResponse.message });
        }

        console.log("✅ Token verified successfully on get roles");

        // --- Get user fullName and roles ---
        const user = await User.findById(tokenResponse.userId).select("fullName roles");
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        return res.status(200).json({
            fullName: user.fullName || "",
            roles: user.roles || [],
        });

    } catch (error) {
        console.error("❌ Error submitting application:", error);

        if (error.status === 401) {
            return res.status(401).json({ success: false, message: "Token invalid or expired" });
        }

        return res.status(500).json({ success: false, error: error.message });
    }
};