import Feedback from "../../models/contact.feedback.model.js";
export const handleFeedback = async (req, res) => {
  try {
    const { email, message } = req.body;
    const newFeedback = new Feedback({ email, message });
    await newFeedback.save();
    res.status(201).json({ message: "Feedback submitted successfully!" });
  } catch (error) {
    console.error("Error handling feedback:", error);
    res.status(500).json({ message: "Failed to submit feedback." });
  }
};
