import jwt from 'jsonwebtoken';
import Admin from '../models/admin.model.js';
import AdminAuditLog from '../models/adminAuditLog.model.js';

/**
 * Verify admin JWT token and attach admin to req.
 * Rejects if admin is not active or is locked.
 */
export const adminTokenVerifier = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.adminId) {
            return res.status(401).json({ success: false, message: 'Invalid admin token' });
        }

        const admin = await Admin.findById(decoded.adminId).select('-password_hash');
        if (!admin) {
            return res.status(401).json({ success: false, message: 'Admin not found' });
        }

        if (admin.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'Account is blocked' });
        }
        if (admin.status === 'pending') {
            return res.status(403).json({ success: false, message: 'Account pending approval' });
        }
        if (admin.locked_until) {
            return res.status(403).json({
                success: false,
                message: 'Account is permanently locked. Contact a SuperAdmin to unlock.'
            });
        }

        req.admin = admin;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token expired' });
        }
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
};

/**
 * Require superadmin role.
 * Must be used AFTER adminTokenVerifier.
 */
export const requireSuperAdmin = (req, res, next) => {
    if (!req.admin || req.admin.role !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'SuperAdmin access required' });
    }
    next();
};

/**
 * Audit logging middleware factory.
 * Logs the admin action after the response is sent.
 */
export const auditLog = (action, targetType = null) => {
    return (req, res, next) => {
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Log after response
            if (req.admin) {
                AdminAuditLog.create({
                    admin_id: req.admin._id,
                    action,
                    target_type: targetType,
                    target_id: req.params.id || null,
                    ip: req.ip || req.connection?.remoteAddress || '',
                    user_agent: req.headers['user-agent'] || '',
                    note: req.body?.reason || '',
                    metadata: { statusCode: res.statusCode }
                }).catch(err => console.error('Audit log error:', err));
            }
            return originalJson(body);
        };
        next();
    };
};

/**
 * Rate limiter for admin routes — simple in-memory per-IP limiter.
 * Limits to `max` requests per `windowMs`.
 */
const rateLimitStore = new Map();

export const adminRateLimiter = (max = 10, windowMs = 60000) => {
    return (req, res, next) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const record = rateLimitStore.get(key);

        if (!record || now > record.resetAt) {
            rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }

        record.count++;
        if (record.count > max) {
            return res.status(429).json({ success: false, message: 'Too many requests. Try again later.' });
        }
        next();
    };
};

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt) rateLimitStore.delete(key);
    }
}, 5 * 60 * 1000);
