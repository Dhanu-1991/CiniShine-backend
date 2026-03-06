/**
 * Seed SuperAdmin Script
 * 
 * Creates (or promotes) the first SuperAdmin account so you can start
 * approving new admin signups. The account is immediately active — no
 * approval workflow needed for the initial SuperAdmin.
 * 
 * Usage:
 *   node scripts/seedSuperAdmin.js
 * 
 * Environment:
 *   MONGO_URI  — MongoDB connection string (from .env)
 * 
 * You will be prompted (or edit the constants below) for:
 *   - name
 *   - contact (email or phone)
 *   - password
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

// ──────────────────────────────────────────────────────────────────────────────
// Edit these defaults or use the interactive prompt
// ──────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
    name: 'SuperAdmin',
    contact: '',   // leave empty to use interactive prompt
    password: ''   // leave empty to use interactive prompt
};

// ──────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  🛡️  WatchInit SuperAdmin Seed Script');
    console.log('═══════════════════════════════════════════\n');

    // Gather input
    const name = DEFAULTS.name || await ask('Admin name: ');
    const contact = DEFAULTS.contact || await ask('Contact (email or phone): ');
    const password = DEFAULTS.password || await ask('Password (min 8 chars): ');

    if (!contact || !password) {
        console.error('❌ Contact and password are required.');
        process.exit(1);
    }
    if (password.length < 8) {
        console.error('❌ Password must be at least 8 characters.');
        process.exit(1);
    }

    const normalizedContact = contact.toLowerCase().trim();

    console.log(`\n📝 Creating SuperAdmin:`);
    console.log(`   Name    : ${name}`);
    console.log(`   Contact : ${normalizedContact}`);
    console.log(`   Role    : superadmin`);
    console.log(`   Status  : active\n`);

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Import model after connection
    const Admin = (await import('../models/admin.model.js')).default;

    // Check if admin already exists
    const existing = await Admin.findOne({ contact: normalizedContact });

    if (existing) {
        if (existing.role === 'superadmin' && existing.status === 'active') {
            console.log('ℹ️  This contact is already a SuperAdmin. No changes needed.');
        } else {
            // Promote to superadmin + activate
            existing.role = 'superadmin';
            existing.status = 'active';
            existing.locked_until = null;
            existing.failed_attempts_count = 0;

            // Update password if provided
            const salt = await bcrypt.genSalt(12);
            existing.password_hash = await bcrypt.hash(password, salt);
            await existing.save();

            console.log(`✅ Existing admin promoted to SuperAdmin and activated.`);
        }
    } else {
        // Create new SuperAdmin
        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(password, salt);

        await Admin.create({
            name: name.trim(),
            contact: normalizedContact,
            password_hash,
            role: 'superadmin',
            status: 'active'
        });

        console.log('✅ SuperAdmin created successfully!');
    }

    console.log('\n🎉 You can now sign in at admin.watchinit.com');
    console.log('   Use your contact + password → OTP → Dashboard\n');

    await mongoose.disconnect();
    rl.close();
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
