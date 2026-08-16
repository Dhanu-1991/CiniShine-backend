import EmailLog from '../../models/emailLog.model.js';

export const listEmailLogs = async (req, res) => {
    try {
        const { page = 1, limit = 20, templateId, adminId, startDate, endDate } = req.query;
        const filter = {};
        if (templateId) filter.templateId = templateId;
        if (adminId) filter.adminId = adminId;
        if (startDate || endDate) {
            filter.sentAt = {};
            if (startDate) filter.sentAt.$gte = new Date(startDate);
            if (endDate) filter.sentAt.$lte = new Date(endDate);
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [logs, total] = await Promise.all([
            EmailLog.find(filter)
                .populate('adminId', 'name email')
                .sort({ sentAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            EmailLog.countDocuments(filter),
        ]);
        
        res.json({
            success: true,
            logs,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                total,
            },
        });
    } catch (err) {
        console.error('[LIST_EMAIL_LOGS]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch email logs' });
    }
};

export const getEmailLog = async (req, res) => {
    try {
        const log = await EmailLog.findById(req.params.id)
            .populate('adminId', 'name email')
            .populate('recipientIds', 'userName channelName contact')
            .lean();
        if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch log' });
    }
};
