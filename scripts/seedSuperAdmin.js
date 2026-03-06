/**
 * Auto Seed SuperAdmin (Production Safe)
 *
 * This runs automatically on server start and creates the first SuperAdmin
 * only if none exists.
 *
 * After creation it will never run again because a SuperAdmin already exists.
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

export async function seedSuperAdmin() {
    try {
        const Admin = (await import("../models/admin.model.js")).default;

        const contact = process.env.SUPERADMIN_CONTACT;
        const password = process.env.SUPERADMIN_PASSWORD;
        const name = process.env.SUPERADMIN_NAME || "SuperAdmin";

        if (!contact || !password) {
            console.log("⚠️ SUPERADMIN env vars not provided. Skipping seed.");
            return;
        }

        const normalizedContact = contact.toLowerCase().trim();

        // Check if any superadmin already exists
        const existingSuper = await Admin.findOne({ role: "superadmin" });

        if (existingSuper) {
            console.log("ℹ️ SuperAdmin already exists. Skipping seed.");
            return;
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

        console.log("✅ SuperAdmin created successfully!");
        console.log(`Contact: ${normalizedContact}`);

    } catch (err) {
        console.error("❌ SuperAdmin seed error:", err);
    }
}