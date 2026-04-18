import jwt from "jsonwebtoken";

/**
 * Cookie-based auth helper utilities.
 *
 * Access token  → short-lived (15 min), httpOnly cookie
 * Refresh token → long-lived (15 days), httpOnly cookie
 *
 * Cross-subdomain support: watchinit.com ↔ api.watchinit.com
 */

const isProduction = () =>
    process.env.NODE_ENV === "production";

const getCookieDomain = () => {
    if (process.env.COOKIE_DOMAIN && process.env.COOKIE_DOMAIN !== 'localhost') {
        return process.env.COOKIE_DOMAIN;
    }
    return undefined; // Let browser default to current domain
};

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_DAYS = 15;
const REFRESH_TOKEN_EXPIRY = `${REFRESH_TOKEN_DAYS}d`;
const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000;        // 15 minutes
const REFRESH_COOKIE_MAX_AGE = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000; // 15 days

/**
 * Base cookie options — environment-aware.
 * In production: secure=true, sameSite=none (required for cross-subdomain cookie sharing).
 * In dev: secure=false, sameSite=lax (works for localhost without HTTPS).
 */
const getBaseCookieOptions = () => {
    const prod = isProduction();
    const domain = getCookieDomain();
    const options = {
        httpOnly: true,
        secure: prod,
        sameSite: prod ? "none" : "lax",
        path: "/",
    };

    // Only set domain if explicitly configured — enables cross-subdomain sharing
    // e.g. COOKIE_DOMAIN=".watchinit.com" allows watchinit.com + api.watchinit.com
    if (domain) {
        options.domain = domain;
    }

    return options;
};

/**
 * Create an access token JWT.
 */
const createAccessToken = (user) =>
    jwt.sign(
        { userId: user._id.toString() },
        process.env.JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

/**
 * Create a refresh token JWT.
 * Includes tokenVersion so we can invalidate all sessions.
 */
const createRefreshToken = (user) =>
    jwt.sign(
        {
            userId: user._id.toString(),
            tokenVersion: user.tokenVersion || 0,
        },
        process.env.JWT_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );

/**
 * Set both access and refresh token cookies on the response.
 */
export const setAuthCookies = (res, user) => {
    const baseOptions = getBaseCookieOptions();
    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);

    res.cookie("access_token", accessToken, {
        ...baseOptions,
        maxAge: ACCESS_COOKIE_MAX_AGE,
    });

    res.cookie("refresh_token", refreshToken, {
        ...baseOptions,
        maxAge: REFRESH_COOKIE_MAX_AGE,
    });

    return { accessToken, refreshToken };
};

/**
 * Clear both auth cookies.
 */
export const clearAuthCookies = (res) => {
    const baseOptions = getBaseCookieOptions();
    // Remove maxAge, set expires to past
    const clearOptions = { ...baseOptions };
    delete clearOptions.maxAge;

    res.clearCookie("access_token", clearOptions);
    res.clearCookie("refresh_token", clearOptions);
};

/**
 * Verify a refresh token and check tokenVersion against the user.
 * Returns { valid: true, userId } or { valid: false, reason }.
 */
export const verifyRefreshToken = (token, user) => {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded.userId) {
            return { valid: false, reason: "Invalid refresh token" };
        }

        // Check tokenVersion matches — if user changed password or logged out everywhere,
        // tokenVersion increments and all old refresh tokens become invalid.
        const currentVersion = user.tokenVersion || 0;
        const tokenVersion = decoded.tokenVersion ?? 0;

        if (tokenVersion !== currentVersion) {
            return { valid: false, reason: "Token has been revoked" };
        }

        return { valid: true, userId: decoded.userId };
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return { valid: false, reason: "Refresh token expired" };
        }
        return { valid: false, reason: "Invalid refresh token" };
    }
};
