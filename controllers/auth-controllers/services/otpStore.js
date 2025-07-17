// otpStorageService.js
const otpStore = new Map();

export function saveOtp(contact, otp) {
  otpStore.set(contact, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min TTL
}

export function getOtp(contact) {
  const record = otpStore.get(contact);
  if (!record || Date.now() > record.expiresAt) return null;
  return record.otp;
}

export function deleteOtp(contact) {
  otpStore.delete(contact);
}
