import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Admin from './models/admin.model.js';
import { removeAdmin } from './controllers/admin-controllers/adminManagementController.js';

dotenv.config();

async function test() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB');

    // Create a fake superadmin
    const superAdmin = await Admin.create({
        name: 'Super Admin Test',
        contact: 'supertest@example.com',
        password_hash: 'hash',
        role: 'superadmin',
        status: 'active'
    });

    // Create a fake admin to remove
    const targetAdmin = await Admin.create({
        name: 'Target Admin',
        contact: 'target@example.com',
        password_hash: 'hash',
        role: 'admin',
        status: 'active'
    });

    // Mock req and res
    const req = {
        params: { id: targetAdmin._id.toString() },
        body: { reason: 'test reason' },
        admin: superAdmin,
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent' }
    };

    const res = {
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(data) {
            console.log('Response:', this.statusCode, data);
        }
    };

    console.log('Calling removeAdmin...');
    try {
        await removeAdmin(req, res);
    } catch(e) {
        console.error('Inner error', e);
    }

    await Admin.findByIdAndDelete(superAdmin._id);
    await Admin.findByIdAndDelete(targetAdmin._id);
    console.log('Cleaned up');
    process.exit(0);
}

test().catch(err => {
    console.error('Error during test:', err);
    process.exit(1);
});
