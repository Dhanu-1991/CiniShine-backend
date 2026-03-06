/**
 * Auto Seed SuperAdmin (Standalone Script)
 *
 * Run manually:
 *   node scripts/seedSuperAdmin.js
 *
 * Requires env:
 *   MONGO_URI
 *   SUPERADMIN_CONTACT
 *   SUPERADMIN_PASSWORD
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

async function seedSuperAdmin() {
    try {
        const contact = process.env.SUPERADMIN_CONTACT;
        const password = process.env.SUPERADMIN_PASSWORD;
        const name = process.env.SUPERADMIN_NAME || "SuperAdmin";

        if (!contact || !password) {
            console.log("❌ SUPERADMIN_CONTACT or SUPERADMIN_PASSWORD missing.");
            process.exit(1);
        }

        console.log("🔌 Connecting to MongoDB...");

        await mongoose.connect(process.env.MONGO_URI);

        console.log("✅ MongoDB connected");

        const Admin = (await import("../models/admin.model.js")).default;

        const normalizedContact = contact.toLowerCase().trim();

        // Check if superadmin exists
        const existingSuper = await Admin.findOne({ role: "superadmin" });

        if (existingSuper) {
            console.log("ℹ️ SuperAdmin already exists.");
            await mongoose.disconnect();
            process.exit(0);
        }

        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(password, salt);

        await Admin.create({
            name,
            contact: normalizedContact,
            password_hash,
            role: "superadmin",
            status: "active",
        });

        console.log("🎉 SuperAdmin created successfully!");
        console.log(`Contact: ${normalizedContact}`);

        await mongoose.disconnect();

        console.log("🔒 MongoDB connection closed");

        process.exit(0);

    } catch (err) {
        console.error("❌ SuperAdmin seed error:", err);
        process.exit(1);
    }
}

seedSuperAdmin();