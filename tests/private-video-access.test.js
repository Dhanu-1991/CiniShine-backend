import assert from 'assert';
import mongoose from 'mongoose';
import payPerViewAccess from '../middlewares/payPerViewAccess.js';
import Content from '../models/content.model.js';

console.log('🧪 Starting Private Video Access Protection Tests...\n');

// Mock Content.findById
const ownerId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
const privateVideoId = new mongoose.Types.ObjectId().toString();
const publicVideoId = new mongoose.Types.ObjectId().toString();

const mockPrivateContent = {
    _id: privateVideoId,
    visibility: 'private',
    userId: ownerId,
    price: 0,
    rentalDuration: 2
};

const mockPublicContent = {
    _id: publicVideoId,
    visibility: 'public',
    userId: ownerId,
    price: 0,
    rentalDuration: 2
};

Content.findById = (id) => {
    return {
        select: () => {
            if (id.toString() === privateVideoId) {
                return Promise.resolve({ ...mockPrivateContent });
            }
            if (id.toString() === publicVideoId) {
                return Promise.resolve({ ...mockPublicContent });
            }
            return Promise.resolve(null);
        }
    };
};

function createMockRes() {
    return {
        statusCode: 200,
        jsonData: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.jsonData = data;
            return this;
        }
    };
}

async function runTests() {
    // Test 1: Anonymous visitor requesting private video -> 404 Not Found
    {
        const req = { params: { id: privateVideoId }, user: null };
        const res = createMockRes();
        let nextCalled = false;
        await payPerViewAccess(req, res, () => { nextCalled = true; });

        assert.strictEqual(res.statusCode, 404, "Anonymous user should receive 404 for private video");
        assert.strictEqual(nextCalled, false, "next() should not be called for anonymous visitor on private video");
        console.log('✓ Test 1 Passed: Anonymous user receives 404 on private video URL');
    }

    // Test 2: Different authenticated user requesting private video -> 404 Not Found
    {
        const req = { params: { id: privateVideoId }, user: { id: otherUserId, role: 'user' } };
        const res = createMockRes();
        let nextCalled = false;
        await payPerViewAccess(req, res, () => { nextCalled = true; });

        assert.strictEqual(res.statusCode, 404, "Non-owner user should receive 404 for private video");
        assert.strictEqual(nextCalled, false, "next() should not be called for non-owner");
        console.log('✓ Test 2 Passed: Non-owner user receives 404 on private video URL');
    }

    // Test 3: Video Owner requesting their own private video -> 200 / Allowed (next called)
    {
        const req = { params: { id: privateVideoId }, user: { id: ownerId, role: 'user' } };
        const res = createMockRes();
        let nextCalled = false;
        await payPerViewAccess(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, true, "next() should be called for video owner");
        console.log('✓ Test 3 Passed: Video creator / owner can view their private video');
    }

    // Test 4: Admin requesting private video -> Allowed (next called)
    {
        const req = { params: { id: privateVideoId }, user: { id: otherUserId, role: 'admin' } };
        const res = createMockRes();
        let nextCalled = false;
        await payPerViewAccess(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, true, "next() should be called for admin");
        console.log('✓ Test 4 Passed: Admin can view private video');
    }

    // Test 5: Public video allows all users
    {
        const req = { params: { id: publicVideoId }, user: null };
        const res = createMockRes();
        let nextCalled = false;
        await payPerViewAccess(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, true, "next() should be called for public video");
        console.log('✓ Test 5 Passed: Public video is accessible to visitors');
    }

    console.log('\n🎉 All 5/5 Private Video Access tests passed successfully!\n');
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
