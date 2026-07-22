import mongoose from "mongoose";

const enquirySchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  status: {
    type: String,
    enum: ["unresolved", "resolved"],
    default: "unresolved",
  },
  adminReply: {
    type: String,
    default: null,
  },
  repliedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

const Enquiry = mongoose.model("Enquiry", enquirySchema);

export default Enquiry;
