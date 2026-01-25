import mongoose from "mongoose";

/* ---------- Portfolio Schema ---------- */
const portfolioSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true },
    platform: {
      type: String,
      enum: [
        "youtube",
        "instagram",
        "behance",
        "linkedin",
        "vimeo",
        "website",
        "other",
      ],
    },
  },
  { _id: false }
);

/* ---------- Application Schema ---------- */
const selectedRolesSchema = new mongoose.Schema(
  {
    /* 🔑 LINK TO USER */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    personalInfo: {
      fullName: { type: String, required: true, trim: true },
      dob: { type: Date, required: true },
      age: { type: Number, required: true },
      gender: {
        type: String,
        enum: ["male", "female", "other"],
        required: true,
      },
    },

    location: {
      language: { type: String, required: true },
      region: { type: String, required: true },
    },

    profilePicture: {
      type: String, // Cloudinary URL
    },

    achievementsPDF: {
      type: String, // Cloudinary URL
    },

    roles: {
      type: [String],
      enum: [
        "Actor",
        "Writer",
        "Director",
        "Singer",
        "Producer",
        "Cinematographer",
        "Editor",
      ],
      required: true,
    },

    experience: {
      type: String,
      enum: ["Beginner", "Intermediate", "Expert"],
    },

    whySelected: {
      type: String,
      trim: true,
    },

    achievements: {
      type: String,
      default: "",
      trim: true,
    },

    /* ✅ PROPER PORTFOLIO STRUCTURE */
    portfolio: {
      type: [portfolioSchema],
      default: [],
    },

    motivation: {
      type: String,
      trim: true,
    },

    futureGoals: {
      type: String,
      trim: true,
    },

    /* OPTIONAL: application lifecycle */
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
  },
  { timestamps: true }
);

const Application = mongoose.model("Application", selectedRolesSchema);
export default Application;
