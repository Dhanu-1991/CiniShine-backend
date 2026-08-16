import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendChangePasswordOtp, changePasswordAuth } from '../controllers/auth-controllers/changepassword.js';

describe('Change Password Controller (Settings)', () => {
    it('sendChangePasswordOtp rejects unauthenticated requests', async () => {
        const req = { user: null, body: { newPassword: 'NewPassword123!' } };
        let statusCode = null;
        let jsonResponse = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                        return data;
                    }
                };
            }
        };

        await sendChangePasswordOtp(req, res);
        assert.strictEqual(statusCode, 401);
        assert.strictEqual(jsonResponse.success, false);
    });

    it('changePasswordAuth rejects request without new password', async () => {
        const req = { user: { id: 'user123' }, body: { otp: '123456' } };
        let statusCode = null;
        let jsonResponse = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                        return data;
                    }
                };
            }
        };

        await changePasswordAuth(req, res);
        assert.strictEqual(statusCode, 400);
        assert.strictEqual(jsonResponse.success, false);
        assert.match(jsonResponse.message, /New password is required/i);
    });

    it('changePasswordAuth rejects request without valid 6-digit OTP', async () => {
        const req = { user: { id: 'user123' }, body: { newPassword: 'ValidPass123!@#', otp: '12' } };
        let statusCode = null;
        let jsonResponse = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                        return data;
                    }
                };
            }
        };

        await changePasswordAuth(req, res);
        assert.strictEqual(statusCode, 400);
        assert.strictEqual(jsonResponse.success, false);
        assert.match(jsonResponse.message, /Valid 6-digit verification code/i);
    });
});
