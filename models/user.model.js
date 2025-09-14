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
    fullName: {
        type: String,
        required: false,
    },
    password: {
        type: String,
        required: [true, "Please provide a password"],
    },
    profilePicture: {
        type: String,
        required: false,
    },
    selectedRolesId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SelectedRole",
        required: false,
    },
    roles: {
      type: [String],
      enum: ["Actor", "Writer", "Director", "Singer", "Producer", "Cinematographer", "Editor"],
      required: false,

}
});

const User = mongoose.model("User", userSchema);
export default User;
