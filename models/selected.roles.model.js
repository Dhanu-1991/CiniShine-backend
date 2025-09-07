import mongoose from "mongoose";

const portfolioSchema = new mongoose.Schema({
  url: { type: String, required: false },
  platform: { 
    type: String, 
    required: false, 
    enum: ["youtube", "instagram", "behance", "linkedin", "vimeo", "website", "other"] 
  }
});

const selectedRolesSchema = new mongoose.Schema(
  {
    personalInfo: {
      fullName: { type: String, required: true, trim: true },
      dob: { type: Date, required: true },
      age: { type: Number, required: true },
      gender: { type: String, enum: ["male", "female", "other"], required: true },
    },
    location: {
      language: { type: String, required: true },
      region: { type: String, required: true },
    },
    profilePicture: {
      type: String, // Cloudinary URL
      required: false,
    },
    achievementsPDF: {
      type: String, // Cloudinary URL for uploaded PDF
      required: false,
    },
    roles: {
      type: [String],
      enum: ["Actor", "Writer", "Director", "Singer", "Producer", "Cinematographer", "Editor"],
      required: true,
    },
    experience: {
      type: String,
      enum: ["Beginner", "Intermediate", "Expert"],
      required: false,
    },
    whySelected: {
      type: String,
      required: false,
      trim: true,
    },
    achievements: {
      type: String,
      default: "",
      trim: true,
    },
      portfolio: {
      type: mongoose.Schema.Types.Mixed,
      default: { url: "", platform: "" },
    },
    motivation: {
      type: String,
      required: false,
    },
    futureGoals: {
      type: String,
      required: false,
    },
  },
  { timestamps: true }
);

const Application = mongoose.model("Application", selectedRolesSchema);

export default Application;
