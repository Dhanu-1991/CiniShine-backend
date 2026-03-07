import Feedback from "../../models/contact.feedback.model.js";
import User from "../../models/user.model.js";

export const handleFeedback = async (req, res) => {
  try {
    const { email, message } = req.body;

    // If user is authenticated, auto-fill email from their account
    let feedbackEmail = email;
    let userId = null;
    if (req.user?.id) {
      userId = req.user.id;
      if (!feedbackEmail) {
        const user = await User.findById(req.user.id).select("email").lean();
        feedbackEmail = user?.email || email;
      }
    }

    if (!feedbackEmail) {
      return res.status(400).json({ message: "Email is required." });
    }

    const newFeedback = new Feedback({
      email: feedbackEmail,
      message,
      ...(userId && { userId }),
    });
    await newFeedback.save();
    res.status(201).json({ message: "Feedback submitted successfully!" });
  } catch (error) {
    console.error("Error handling feedback:", error);
    res.status(500).json({ message: "Failed to submit feedback." });
  }
};
