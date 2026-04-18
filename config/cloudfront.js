/**
 * CloudFront Configuration Module
 * 
 * Provides:
 * 1. Signed cookie generation for authenticated content access via CloudFront
 * 2. CloudFront URL construction (replaces S3 presigned URLs)
 * 3. Cookie-setting endpoint handler
 * 
 * Flow:
 *  - Backend returns plain CloudFront URLs (https://d2tsrbykz2omrr.cloudfront.net/<key>)
 *  - Frontend calls GET /api/v2/auth/cloudfront-cookies to receive signed cookies
 *  - Cookies are set on the CloudFront domain, browser sends them automatically
 *  - CloudFront validates cookies and serves content from S3 origin
 * 
 * Required ENV vars:
 *   CLOUDFRONT_DOMAIN          – e.g. d2tsrbykz2omrr.cloudfront.net
 *   CLOUDFRONT_KEY_PAIR_ID     – CloudFront public key ID (from Key Group)
 *   CLOUDFRONT_PRIVATE_KEY     – PEM-encoded RSA private key (newlines as \n in .env)
 *   CLOUDFRONT_COOKIE_DOMAIN   – domain for Set-Cookie (e.g. d2tsrbykz2omrr.cloudfront.net)
 */

import { getSignedCookies } from '@aws-sdk/cloudfront-signer';

// ─── Configuration ───────────────────────────────────────────────────────────

const CF_DOMAIN = () => process.env.CLOUDFRONT_DOMAIN;
const CF_KEY_PAIR_ID = () => process.env.CLOUDFRONT_KEY_PAIR_ID;
const CF_PRIVATE_KEY = () => {
    const key = process.env.CLOUDFRONT_PRIVATE_KEY;
    if (!key) return '';
    // Handle escaped newlines in .env file
    return key.replace(/\\n/g, '\n');
};

const getSigningConfigIssues = () => {
    const issues = [];

    if (!CF_DOMAIN()) issues.push('CLOUDFRONT_DOMAIN');
    if (!CF_KEY_PAIR_ID()) issues.push('CLOUDFRONT_KEY_PAIR_ID');

    const privateKey = CF_PRIVATE_KEY();
    if (!privateKey) {
        issues.push('CLOUDFRONT_PRIVATE_KEY');
    } else if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
        issues.push('CLOUDFRONT_PRIVATE_KEY_FORMAT');
    }

    return issues;
};

const assertSigningConfig = () => {
    const issues = getSigningConfigIssues();
    if (issues.length > 0) {
        const error = new Error('CloudFront signing configuration is incomplete');
        error.code = 'CF_SIGNING_CONFIG_MISSING';
        error.issues = issues;
        throw error;
    }
};

const resolveCookieDomain = (req) => {
    // Prefer explicit env override for production control.
    if (process.env.CLOUDFRONT_COOKIE_DOMAIN) {
        return process.env.CLOUDFRONT_COOKIE_DOMAIN;
    }

    // Fallback to the actual host that served this response so browsers accept Set-Cookie.
    // This is useful when the endpoint is routed through a custom CF alias (for example media.example.com).
    const host = req?.hostname;
    return host || CF_DOMAIN();
};

// Cookie lifetime: 24 hours (renewed on each page load)
const COOKIE_EXPIRY_SECONDS = 24 * 60 * 60;

// ─── URL Construction ────────────────────────────────────────────────────────

/**
 * Convert an S3 key to a CloudFront URL.
 * Returns null if key is falsy.
 * If the key is already a full URL (http/https), extract the path and re-map.
 */
export function cfUrl(key) {
    if (!key) return null;

    // Already on our CloudFront distribution — return as-is
    if (key.startsWith(`https://${CF_DOMAIN()}`)) return key;

    // External URL that is NOT an S3 URL (e.g. Google, Gravatar, etc.)
    // → return unchanged so these render correctly without going through CF
    if (key.startsWith('http') && !key.includes('.amazonaws.com')) {
        return key;
    }

    // Full S3 URL — extract just the object key and remap to CF
    if (key.startsWith('http')) {
        try {
            const url = new URL(key);
            const path = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
            if (!path) return null;
            return `https://${CF_DOMAIN()}/${path}`;
        } catch {
            return null;
        }
    }

    // Plain S3 key (e.g. "profilePictures/userId/file.jpg") — prepend CF domain
    return `https://${CF_DOMAIN()}/${key}`;
}

/**
 * Generate a CloudFront URL for an S3 key — replaces getSignedUrl / getSignedUrlIfExists.
 * No HEAD check needed because CloudFront will return 403/404 if the object is missing.
 * This is intentional: removes the costly HEAD + sign round-trip from every request.
 */
export function getCfUrl(key) {
    return cfUrl(key);
}

/**
 * Build the HLS master playlist URL that points to CloudFront
 * (used by the video controller to tell the frontend where master.m3u8 lives)
 */
export function getCfHlsMasterUrl(hlsMasterKey) {
    if (!hlsMasterKey) return null;
    return cfUrl(hlsMasterKey);
}

// ─── Signed Cookies ──────────────────────────────────────────────────────────

/**
 * Generate CloudFront signed cookies that grant access to ALL content
 * under the distribution (wildcard resource: https://domain/*).
 * 
 * These cookies are:
 *   CloudFront-Policy
 *   CloudFront-Signature
 *   CloudFront-Key-Pair-Id
 */
export function generateSignedCookies() {
    assertSigningConfig();

    const expiry = new Date(Date.now() + COOKIE_EXPIRY_SECONDS * 1000);

    // Custom policy granting access to all resources under this distribution
    const resource = `https://${CF_DOMAIN()}/*`;

    const cookies = getSignedCookies({
        keyPairId: CF_KEY_PAIR_ID(),
        privateKey: CF_PRIVATE_KEY(),
        policy: JSON.stringify({
            Statement: [
                {
                    Resource: resource,
                    Condition: {
                        DateLessThan: {
                            'AWS:EpochTime': Math.floor(expiry.getTime() / 1000)
                        }
                    }
                }
            ]
        })
    });

    return { cookies, expiry };
}

// ─── Express Handler ─────────────────────────────────────────────────────────

/**
 * GET /api/v2/auth/cloudfront-cookies
 * 
 * Sets signed cookies for the CloudFront domain so the browser automatically
 * attaches them to every CloudFront request (thumbnails, HLS, media, etc.).
 * 
 * The frontend must call this once per session and then all <img>, <video>,
 * HLS.js fetch requests to CloudFront will "just work".
 */
export const issueCloudFrontCookies = (req, res) => {
    try {
        const { cookies, expiry } = generateSignedCookies();
        const cookieDomain = resolveCookieDomain(req);

        // Common cookie options
        const cookieOpts = {
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None', // Required for cross-origin cookie
            expires: expiry
        };

        if (cookieDomain) {
            cookieOpts.domain = cookieDomain;
        }

        // Set each CloudFront cookie
        res.cookie('CloudFront-Policy', cookies['CloudFront-Policy'], cookieOpts);
        res.cookie('CloudFront-Signature', cookies['CloudFront-Signature'], cookieOpts);
        res.cookie('CloudFront-Key-Pair-Id', cookies['CloudFront-Key-Pair-Id'], cookieOpts);

        res.json({
            success: true,
            message: 'CloudFront cookies set',
            expiresAt: expiry.toISOString(),
            cfDomain: CF_DOMAIN(),
            cookieDomain,
        });
    } catch (error) {
        if (error.code === 'CF_SIGNING_CONFIG_MISSING') {
            console.warn('⚠️ CloudFront cookie signing disabled — missing config:', error.issues);
            return res.status(200).json({
                success: false,
                disabled: true,
                message: 'CloudFront cookie signing is not configured on the server',
                cfDomain: CF_DOMAIN() || null,
                missing: error.issues,
            });
        }

        console.error('❌ Error generating CloudFront cookies:', error);
        res.status(500).json({ error: 'Failed to generate CloudFront access cookies' });
    }
};
