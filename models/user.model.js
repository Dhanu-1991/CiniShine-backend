import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    contact: {
        type: String,
        required: [true, "Please provide a contact "],
        unique: true
    },
    userName: {
        type: String,
        required: [true, "Please provide a username"],
    },
    password: {
        type: String,
        required: [true, "Please provide a password"],
    }

});

const User = mongoose.model("User", userSchema);
export default User;
