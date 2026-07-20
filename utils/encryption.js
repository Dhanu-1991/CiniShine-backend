/**
 * AES-256-GCM encryption utility for sensitive wallet/bank data.
 * Uses WALLET_ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 *
 * Each encrypt call generates a unique IV and authentication tag,
 * stored alongside the ciphertext so each field can be decrypted independently.
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getKey() {
    const hexKey = process.env.WALLET_ENCRYPTION_KEY;
    if (!hexKey || hexKey.length !== 64) {
        throw new Error('WALLET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @returns {{ encrypted: string, iv: string, tag: string }} hex-encoded values
 */
export function encrypt(plaintext) {
    if (!plaintext) return { encrypted: null, iv: null, tag: null };
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return {
        encrypted,
        iv: iv.toString('hex'),
        tag,
    };
}

/**
 * Decrypt a ciphertext using its IV and authentication tag.
 * @param {string} encrypted - hex-encoded ciphertext
 * @param {string} iv - hex-encoded IV
 * @param {string} tag - hex-encoded auth tag
 * @returns {string} plaintext
 */
export function decrypt(encrypted, iv, tag) {
    if (!encrypted || !iv || !tag) return null;
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Encrypt a set of bank details fields.
 * @returns {Object} encrypted fields ready to spread into a Mongoose document
 */
export function encryptBankDetails({ bankAccountNumber, bankName, ifscCode, accountHolderName }) {
    const acct = encrypt(bankAccountNumber);
    const bank = encrypt(bankName);
    const ifsc = encrypt(ifscCode);
    const holder = encrypt(accountHolderName);
    return {
        bankAccountNumberEncrypted: acct.encrypted,
        bankAccountIv: acct.iv,
        bankAccountTag: acct.tag,
        bankNameEncrypted: bank.encrypted,
        bankNameIv: bank.iv,
        bankNameTag: bank.tag,
        ifscCodeEncrypted: ifsc.encrypted,
        ifscCodeIv: ifsc.iv,
        ifscCodeTag: ifsc.tag,
        accountHolderNameEncrypted: holder.encrypted,
        accountHolderNameIv: holder.iv,
        accountHolderNameTag: holder.tag,
    };
}

/**
 * Decrypt bank details from a Mongoose document (wallet or payout).
 * @returns {{ bankAccountNumber, bankName, ifscCode, accountHolderName }}
 */
export function decryptBankDetails(doc) {
    return {
        bankAccountNumber: decrypt(doc.bankAccountNumberEncrypted, doc.bankAccountIv, doc.bankAccountTag),
        bankName: decrypt(doc.bankNameEncrypted, doc.bankNameIv, doc.bankNameTag),
        ifscCode: decrypt(doc.ifscCodeEncrypted, doc.ifscCodeIv, doc.ifscCodeTag),
        accountHolderName: decrypt(doc.accountHolderNameEncrypted, doc.accountHolderNameIv, doc.accountHolderNameTag),
    };
}
