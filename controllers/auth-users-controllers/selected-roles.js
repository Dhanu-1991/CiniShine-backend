import Application from "../../models/selected.roles.model.js";
import { tokenVerifier } from "../auth-controllers/tokenverifier.js";
import User from "../../models/user.model.js";

// Submit Application Controller
export const selectedRoles = async (req, res) => {
  try {
    // --- Verify Token ---
    const tokenResponse = await tokenVerifier(req);

    if (!tokenResponse || typeof tokenResponse.status !== "number") {
      return res.status(401).json({ message: "Invalid token response" });
    }

    if (tokenResponse.status !== 200) {
      return res.status(tokenResponse.status).json({ message: tokenResponse.message });
    }

    console.log("✅ Token verified successfully");

    // --- Parse JSON fields ---
    const personalInfo = JSON.parse(req.body.personalInfo || "{}");
    const location = JSON.parse(req.body.location || "{}");
    const roles = JSON.parse(req.body.roles || "[]");
    const portfolio = JSON.parse(req.body.portfolio || "{}");

    // --- Uploaded files ---
    let profilePictureUrl = null;
    let achievementsPdfUrl = null;

    if (req.files?.profilePicture?.[0]) {
      profilePictureUrl = req.files.profilePicture[0].path;
      await User.findByIdAndUpdate(
        tokenResponse.userId,
        { profilePicture: profilePictureUrl },
        { new: true }
      );
    }

    if (req.files?.achievementsPDF?.[0]) {
      achievementsPdfUrl = req.files.achievementsPDF[0].path; // cloudinary secure_url
    }

    // --- Save application ---
    const application = new Application({
      personalInfo,
      location,
      roles,
      portfolio,
      experience: req.body.experience,
      whySelected: req.body.whySelected,
      achievements: req.body.achievements,
      motivation: req.body.motivation,
      futureGoals: req.body.futureGoals,
      profilePicture: profilePictureUrl,
      achievementsPDF: achievementsPdfUrl,
    });

    await application.save();
    console.log("✅ Application saved:", application);

    return res.status(200).json({
      success: true,
      message: "Application submitted successfully",
      application,
    });
  } catch (error) {
    console.error("❌ Error submitting application:", error);

    if (error.status === 401) {
      return res.status(401).json({ success: false, message: "Token invalid or expired" });
    }

    return res.status(500).json({ success: false, error: error.message });
  }
};
