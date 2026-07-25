// otpStorageService.js
const otpStore = new Map();

export function saveOtp(contact, otp) {
  const existing = otpStore.get(contact);
  if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt < 30000)) {
    const waitSec = Math.ceil((30000 - (Date.now() - existing.lastSentAt)) / 1000);
    const error = new Error(`Please wait ${waitSec} seconds before requesting another OTP.`);
    error.statusCode = 429;
    error.retryAfterSec = waitSec;
    throw error;
  }
  otpStore.set(contact, {
    otp,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    lastSentAt: Date.now()
  });
}

export function getOtp(contact) {
  const record = otpStore.get(contact);
  if (!record || Date.now() > record.expiresAt) return null;
  return record.otp;
}

export function deleteOtp(contact) {
  otpStore.delete(contact);
}

