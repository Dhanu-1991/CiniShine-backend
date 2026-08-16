// otpStorageService.js
const otpStore = new Map();
const verifiedStore = new Map();

const normalizeKey = (contact) => {
  if (!contact) return '';
  return typeof contact === 'string' ? contact.trim().toLowerCase() : String(contact);
};

export function saveOtp(contact, otp) {
  const key = normalizeKey(contact);
  const existing = otpStore.get(key);
  if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt < 30000)) {
    const waitSec = Math.ceil((30000 - (Date.now() - existing.lastSentAt)) / 1000);
    const error = new Error(`Please wait ${waitSec} seconds before requesting another OTP.`);
    error.statusCode = 429;
    error.retryAfterSec = waitSec;
    throw error;
  }
  otpStore.set(key, {
    otp: String(otp).trim(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    lastSentAt: Date.now()
  });
}

export function getOtp(contact) {
  const key = normalizeKey(contact);
  const record = otpStore.get(key);
  if (!record || Date.now() > record.expiresAt) return null;
  return record.otp;
}

export function deleteOtp(contact) {
  const key = normalizeKey(contact);
  otpStore.delete(key);
}

export function markVerified(contact, ttlMs = 10 * 60 * 1000) {
  const key = normalizeKey(contact);
  verifiedStore.set(key, {
    verifiedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
}

export function isVerified(contact) {
  const key = normalizeKey(contact);
  const record = verifiedStore.get(key);
  if (!record || Date.now() > record.expiresAt) return false;
  return true;
}

export function clearVerified(contact) {
  const key = normalizeKey(contact);
  verifiedStore.delete(key);
}

