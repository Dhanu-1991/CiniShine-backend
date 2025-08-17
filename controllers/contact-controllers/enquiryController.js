import Enquiry from "../../models/contact.enquiry.model.js";

export const handleEnquiry = async (req, res) => {
  try {
    const { email, message } = req.body;
    const newEnquiry = new Enquiry({ email, message });
    await newEnquiry.save();
    res.status(201).json({ message: "Enquiry submitted successfully!" });
  } catch (error) {
    console.error("Error handling enquiry:", error);
    res.status(500).json({ message: "Failed to submit enquiry." });
  }
};
