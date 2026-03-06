import Admin from '../../models/admin.model.js';
import AdminRequest from '../../models/adminRequest.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';
import AdminNotification from '../../models/adminNotification.model.js';

function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || '';
}

/**
 * POST /admin/approve-signup
 * SuperAdmin approves a pending admin signup.
 */
export const approveSignup = async (req, res) => {
    try {
        const { requestId } = req.body;
        if (!requestId) {
            return res.status(400).json({ success: false, message: 'Request ID required' });
        }

        const request = await AdminRequest.findById(requestId);
        if (!request || request.type !== 'signup' || request.status !== 'pending') {
            return res.status(404).json({ success: false, message: 'Request not found or already processed' });
        }

        const admin = await Admin.findOne({ contact: request.requester_contact });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin account not found' });
        }

        admin.status = 'active';
        await admin.save();

        request.status = 'approved';
        request.reviewed_by_admin = req.admin._id;
        await request.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'signup_approved',
            target_type: 'admin',
            target_id: admin._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Approved signup for ${admin.contact}`
        });

        return res.status(200).json({
            success: true,
            message: `Admin "${admin.name}" has been approved and activated.`
        });
    } catch (error) {
        console.error('Approve signup error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/reject-signup
 * SuperAdmin rejects a pending admin signup.
 */
export const rejectSignup = async (req, res) => {
    try {
        const { requestId, note } = req.body;
        if (!requestId) {
            return res.status(400).json({ success: false, message: 'Request ID required' });
        }

        const request = await AdminRequest.findById(requestId);
        if (!request || request.type !== 'signup' || request.status !== 'pending') {
            return res.status(404).json({ success: false, message: 'Request not found or already processed' });
        }

        request.status = 'rejected';
        request.reviewed_by_admin = req.admin._id;
        request.review_note = note || '';
        await request.save();

        // Also remove the pending admin account
        await Admin.findOneAndDelete({ contact: request.requester_contact, status: 'pending' });

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'signup_rejected',
            target_type: 'admin',
            target_id: null,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Rejected signup for ${request.requester_contact}. ${note || ''}`
        });

        return res.status(200).json({ success: true, message: 'Signup request rejected.' });
    } catch (error) {
        console.error('Reject signup error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/requests
 * List pending admin requests (signup approvals, forgot-password activations).
 */
export const listRequests = async (req, res) => {
    try {
        const { status = 'pending', type, page = 1, limit = 20 } = req.query;

        const filter = {};
        if (status) filter.status = status;
        if (type) filter.type = type;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [requests, total] = await Promise.all([
            AdminRequest.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('reviewed_by_admin', 'name contact'),
            AdminRequest.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            requests,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List requests error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * DELETE /admin/remove-admin/:id
 * SuperAdmin removes an admin at any time.
 */
export const removeAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (id === req.admin._id.toString()) {
            return res.status(400).json({ success: false, message: 'Cannot remove yourself' });
        }

        const targetAdmin = await Admin.findById(id);
        if (!targetAdmin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // SuperAdmins can't be removed by other superadmins — only by themselves (which is blocked above)
        if (targetAdmin.role === 'superadmin' && req.admin.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'Cannot remove a SuperAdmin' });
        }

        await Admin.findByIdAndDelete(id);

        await AdminNotification.create({
            type: 'admin_removed',
            title: 'Admin Removed',
            message: `Admin "${targetAdmin.name}" (${targetAdmin.contact}) was removed by ${req.admin.name}.`,
            severity: 'warning',
            metadata: { removed_admin_id: id, removed_by: req.admin._id }
        });

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'admin_remove',
            target_type: 'admin',
            target_id: id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: reason || `Removed admin ${targetAdmin.name}`
        });

        return res.status(200).json({ success: true, message: `Admin "${targetAdmin.name}" has been removed.` });
    } catch (error) {
        console.error('Remove admin error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/list-admins
 * List all admins (for admin management).
 */
export const listAdmins = async (req, res) => {
    try {
        const admins = await Admin.find()
            .select('-password_hash')
            .sort({ createdAt: -1 });

        return res.status(200).json({ success: true, admins });
    } catch (error) {
        console.error('List admins error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/unlock-admin/:id
 * SuperAdmin unlocks a permanently locked admin account.
 */
export const unlockAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const admin = await Admin.findById(id);
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        if (!admin.locked_until) {
            return res.status(400).json({ success: false, message: 'Admin is not locked' });
        }

        admin.locked_until = null;
        admin.failed_attempts_count = 0;
        await admin.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'admin_unlock',
            target_type: 'admin',
            target_id: admin._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `SuperAdmin unlocked admin "${admin.name}"`
        });

        await AdminNotification.create({
            type: 'admin_unlocked',
            title: 'Admin Account Unlocked',
            message: `Admin "${admin.name}" (${admin.contact}) was unlocked by ${req.admin.name}.`,
            severity: 'info',
            metadata: { admin_id: admin._id }
        });

        return res.status(200).json({ success: true, message: 'Admin account unlocked successfully' });
    } catch (error) {
        console.error('Unlock admin error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
