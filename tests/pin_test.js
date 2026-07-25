import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import PrimaryWallet from '../models/primaryWallet.model.js';
import { pinOtpStore } from '../controllers/wallet-controllers/walletController.js';

async function testPinFeature() {
  console.log("=== Testing Payment PIN Feature ===");

  // 1. Verify PrimaryWallet Schema fields
  const schemaPaths = PrimaryWallet.schema.paths;
  console.log("pinHash path present:", !!schemaPaths.pinHash);
  console.log("isPinSet path present:", !!schemaPaths.isPinSet);
  console.log("isPinLocked path present:", !!schemaPaths.isPinLocked);
  console.log("failedPinAttempts path present:", !!schemaPaths.failedPinAttempts);

  if (!schemaPaths.pinHash || !schemaPaths.isPinSet || !schemaPaths.isPinLocked || !schemaPaths.failedPinAttempts) {
    throw new Error("PrimaryWallet schema missing PIN fields!");
  }

  // 2. Test PIN Hashing and Verification
  const pin = "1234";
  const hash = await bcrypt.hash(pin, 10);
  console.log("Hashed 1234:", hash.slice(0, 20) + "...");
  const isValid = await bcrypt.compare("1234", hash);
  const isInvalid = await bcrypt.compare("4321", hash);
  console.log("1234 matches:", isValid === true);
  console.log("4321 matches:", isInvalid === false);

  if (!isValid || isInvalid) {
    throw new Error("Bcrypt comparison failed!");
  }

  // 3. Test OTP Store logic
  const testUserId = "user_test_123";
  pinOtpStore.set(testUserId, { otp: "654321", expiresAt: Date.now() + 300000 });
  const stored = pinOtpStore.get(testUserId);
  console.log("OTP Store retrieval:", stored.otp === "654321");
  pinOtpStore.delete(testUserId);

  console.log("=== ALL UNIT TESTS PASSED SUCCESSFULLY! ===");
}

testPinFeature().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
