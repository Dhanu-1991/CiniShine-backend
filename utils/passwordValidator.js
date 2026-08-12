/**
 * Validate password strength - industry standard requirements.
 * Returns { valid: boolean, errors: string[] }
 */
export function validatePasswordStrength(password) {
    const errors = [];
    if (!password || typeof password !== 'string') {
        return { valid: false, errors: ['Password is required'] };
    }
    if (password.length < 8) errors.push('At least 8 characters');
    if (password.length > 128) errors.push('Maximum 128 characters');
    if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter');
    if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter');
    if (!/[0-9]/.test(password)) errors.push('At least one number');
    if (!/[!@#$%^&*()_+\-=\[\]{}|;:\'",.<>?/~`]/.test(password)) errors.push('At least one special character');
    return { valid: errors.length === 0, errors };
}
