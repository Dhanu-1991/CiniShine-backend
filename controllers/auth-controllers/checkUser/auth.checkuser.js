import User from "../../../models/user.model.js";

const checkUser = async (req, res, next) => {
    try {
        const { contact } = req.body;
        
        const existingUser = await User.findOne({ contact });
        // Check if the user already exists
        if (existingUser) {
            return res.status(200).json({ message: "User already exists" });
        }

        console.log("User does not exist");
        res.status(200).json({ message: `User does not exist` });


    } catch (error) {
        console.log("Error in checkUser controller:", error);
        res.status(500).json({ message: "Internal server error" });
        next(error);
    }
};

export default checkUser;