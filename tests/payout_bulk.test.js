import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import OtpSession from '../models/adminOtpSession.model.js';
import { sendBulkPayoutOtp, runMonthEndPayout } from '../controllers/wallet-controllers/payoutJobController.js';

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}

describe('Bulk Payout Execution & Security OTP', () => {
    const testAdminId = new mongoose.Types.ObjectId();
    const testAdminContact = 'dhanushkumarvr019@gmail.com';
    const testOtp = '654321';

    before(async () => {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(uri);
        }
    });

    after(async () => {
        await OtpSession.deleteMany({ contact: testAdminContact });
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    });

    it('should generate and store bulk payout OTP session', async () => {
        const reqOtp = { admin: { _id: testAdminId, contact: testAdminContact } };
        const resOtp = mockRes();

        await sendBulkPayoutOtp(reqOtp, resOtp);

        assert.equal(resOtp.statusCode, 200);
        assert.equal(resOtp.body.success, true);

        const session = await OtpSession.findOne({ contact: testAdminContact, purpose: 'bulk_payout' });
        assert.ok(session);
    });

    it('should execute runMonthEndPayout without ReferenceError/500 error when OTP is valid', async () => {
        // Set test OTP hash in DB
        const testOtpHash = crypto.createHash('sha256').update(testOtp).digest('hex');
        await OtpSession.findOneAndUpdate(
            { contact: testAdminContact, purpose: 'bulk_payout' },
            { otp_hash: testOtpHash, expires_at: new Date(Date.now() + 5 * 60 * 1000) }
        );

        const reqRun = {
            admin: { _id: testAdminId, contact: testAdminContact },
            body: { otp: testOtp, month: '2026-07' }
        };
        const resRun = mockRes();

        await runMonthEndPayout(reqRun, resRun);

        assert.equal(resRun.statusCode, 200);
        assert.equal(resRun.body.success, true);
        assert.equal(typeof resRun.body.totalWallets, 'number');
        assert.equal(typeof resRun.body.processed, 'number');
        assert.equal(typeof resRun.body.skipped, 'number');
        assert.equal(typeof resRun.body.failed, 'number');
    });
});
