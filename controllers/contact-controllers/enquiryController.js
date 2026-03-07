import Enquiry from "../../models/contact.enquiry.model.js";
import User from "../../models/user.model.js";

export const handleEnquiry = async (req, res) => {
  try {
    const { email, message } = req.body;

    let enquiryEmail = email;
    if (req.user?.id && !enquiryEmail) {
      const user = await User.findById(req.user.id)
        .select("email contact")
        .lean();
      enquiryEmail = user?.email || user?.contact || email;
    }

    if (!enquiryEmail) {
      return res.status(400).json({ message: "Email is required." });
    }

    const newEnquiry = new Enquiry({
      email: enquiryEmail,
      message,
      ...(req.user?.id ? { userId: req.user.id } : {}),
    });
    await newEnquiry.save();
    res.status(201).json({ message: "Enquiry submitted successfully!" });
  } catch (error) {
    console.error("Error handling enquiry:", error);
    res.status(500).json({ message: "Failed to submit enquiry." });
  }
};
