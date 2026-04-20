import User from "../../../models/user.model.js";

const checkUser = async (req, res) => {
    try {
        const { contact } = req.body;
        
        // Case-insensitive contact lookup
        const escapedContact = contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const existingUser = await User.findOne({ contact: { $regex: new RegExp(`^${escapedContact}$`, 'i') } });
        if (existingUser) {
            return res.status(409).json({ exists: true, message: "User already exists" });
        }

        res.status(200).json({ exists: false, message: "User does not exist" });

    } catch (error) {
        console.error("Error in checkUser controller:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export default checkUser;