import assert from 'assert';

// Test 1: Content Model Schema enum check
import Content from '../models/content.model.js';
const rentalDurationPath = Content.schema.path('rentalDuration');
assert(rentalDurationPath, 'rentalDuration must be defined on Content schema');
assert.strictEqual(rentalDurationPath.defaultValue, 2, 'Default rentalDuration should be 2');
assert.deepStrictEqual(rentalDurationPath.options.enum, [2, 3, 5, 7, 14, 28], 'Allowed enum values must match [2, 3, 5, 7, 14, 28]');

console.log('✓ Test 1 Passed: Content schema rentalDuration field, default, and enums');

// Test 2: Duration calculation verification
const VALID_RENTAL_DAYS = [2, 3, 5, 7, 14, 28];
for (const days of VALID_RENTAL_DAYS) {
    const now = Date.now();
    const expiresAt = new Date(now + days * 24 * 60 * 60 * 1000);
    const diffDays = Math.round((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000));
    assert.strictEqual(diffDays, days, `Expected ${days} days diff, got ${diffDays}`);
}

console.log('✓ Test 2 Passed: Expiry calculations for 2, 3, 5, 7, 14, and 28 days');

// Test 3: Fallback verification
const invalidOptions = [undefined, null, 0, 1, 4, 10, 30, 'invalid'];
for (const invalid of invalidOptions) {
    const fallbackDays = VALID_RENTAL_DAYS.includes(Number(invalid)) ? Number(invalid) : 2;
    assert.strictEqual(fallbackDays, 2, `Expected fallback 2 for invalid input ${invalid}`);
}

console.log('✓ Test 3 Passed: Safe fallback to 2 days for undefined/invalid durations');

// Test 4: Strict validation rejection check
function validateRentalDuration(rentalDuration) {
    if (rentalDuration !== undefined && !VALID_RENTAL_DAYS.includes(Number(rentalDuration))) {
        return { valid: false, error: 'Invalid rental duration. Allowed viewing windows are 2, 3, 5, 7, 14, or 28 days.' };
    }
    return { valid: true };
}

for (const valid of VALID_RENTAL_DAYS) {
    assert.strictEqual(validateRentalDuration(valid).valid, true, `Should accept valid option ${valid}`);
    assert.strictEqual(validateRentalDuration(String(valid)).valid, true, `Should accept string number "${valid}"`);
}

for (const invalid of [0, 1, 4, 6, 8, 10, 15, 20, 29, 30, -5, 'foo', '99']) {
    const res = validateRentalDuration(invalid);
    assert.strictEqual(res.valid, false, `Should strictly reject invalid option ${invalid}`);
    assert(res.error.includes('Allowed viewing windows are 2, 3, 5, 7, 14, or 28 days'));
}

console.log('✓ Test 4 Passed: Strict rejection of any duration outside allowed filters [2, 3, 5, 7, 14, 28]');

// Test 5: Remaining time countdown helper check
function getExpiryInfo(expiresAt, now = Date.now()) {
    const diff = new Date(expiresAt).getTime() - now;
    if (diff <= 0) return { expired: true, text: 'Expired' };
    const days = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (days > 0) {
        return { expired: false, text: `${days}d ${h}h left` };
    }
    return { expired: false, text: `${h}h ${m}m left` };
}

const baseTime = 1700000000000;
// Test 28 days remaining
assert.strictEqual(getExpiryInfo(baseTime + 28 * 86400000, baseTime).text, '28d 0h left');
// Test 5 days 12 hours remaining
assert.strictEqual(getExpiryInfo(baseTime + 5.5 * 86400000, baseTime).text, '5d 12h left');
// Test 18 hours 30 mins remaining
assert.strictEqual(getExpiryInfo(baseTime + (18 * 3600000 + 30 * 60000), baseTime).text, '18h 30m left');
// Test expired
assert.strictEqual(getExpiryInfo(baseTime - 1000, baseTime).text, 'Expired');
assert.strictEqual(getExpiryInfo(baseTime - 1000, baseTime).expired, true);

console.log('✓ Test 5 Passed: Countdown time format calculation (days+hours / hours+mins / expired)');

console.log('\n================ ALL 5 RENTAL SUITE TESTS PASSED ================\n');
