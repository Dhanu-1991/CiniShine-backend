import express from 'express';
import {
    adminSignin, adminVerifyOtp, adminSignup, adminResendOtp,
    forgotPasswordRequest, forgotPasswordApprove, adminResetPassword
} from '../../controllers/admin-controllers/adminAuthController.js';
import {
    approveSignup, rejectSignup, listRequests, removeAdmin, listAdmins, unlockAdmin
} from '../../controllers/admin-controllers/adminManagementController.js';
import {
    hideContent, removeContent, restoreContent, deleteContent,
    listArchive, getContentDetails, getCreatorAnalytics, searchCreators,
    getCreatorProfile, getCreatorStudio, banChannel, unbanChannel, requestBanChannel,
    updateContentStats, updateCreatorStats
} from '../../controllers/admin-controllers/adminContentController.js';
import {
    getDashboard, listReports, resolveReport, listFeedbacks, listEnquiries,
    listAuditLogs, listNotifications, markNotificationRead
} from '../../controllers/admin-controllers/adminDashboardController.js';
import { getAnalytics } from '../../controllers/admin-controllers/adminAnalyticsController.js';
import {
    getPlatformAnalytics, getContentAnalytics, getUserAnalytics,
    searchUsersForAnalytics, runAggregation
} from '../../controllers/admin-controllers/adminAdvancedAnalyticsController.js';
import {
    adminSendMessage, adminGetMessages, adminGetConversations
} from '../../controllers/admin-controllers/adminChatController.js';
import {
    adminTokenVerifier, requireSuperAdmin, auditLog, adminRateLimiter
} from '../../middlewares/admin.middleware.js';

const adminRouter = express.Router();

// ─── Public (unauthenticated) admin routes ───────────────────────────────────
adminRouter.post('/signin', adminRateLimiter(10, 60000), adminSignin);
adminRouter.post('/verify-otp', adminRateLimiter(10, 60000), adminVerifyOtp);
adminRouter.post('/signup', adminRateLimiter(5, 60000), adminSignup);
adminRouter.post('/resend-otp', adminRateLimiter(3, 60000), adminResendOtp);
adminRouter.post('/forgot-password-request', adminRateLimiter(3, 60000), forgotPasswordRequest);
adminRouter.post('/reset-password', adminRateLimiter(5, 60000), adminResetPassword);

// ─── Protected routes (require valid admin JWT) ─────────────────────────────
adminRouter.use(adminTokenVerifier);

// Dashboard
adminRouter.get('/dashboard', getDashboard);

// Platform analytics
adminRouter.get('/analytics', getAnalytics);

// Advanced analytics
adminRouter.get('/analytics/platform', getPlatformAnalytics);
adminRouter.get('/analytics/content', getContentAnalytics);
adminRouter.get('/analytics/user-search', searchUsersForAnalytics);
adminRouter.get('/analytics/user/:userId', getUserAnalytics);

// Reports & Feedbacks
adminRouter.get('/reports', listReports);
adminRouter.post('/reports/:id/resolve', auditLog('report_review', 'report'), resolveReport);
adminRouter.get('/feedbacks', listFeedbacks);
adminRouter.get('/enquiries', listEnquiries);

// Content management
adminRouter.get('/content/:id', getContentDetails);
adminRouter.post('/content/:id/hide', auditLog('content_hide', 'content'), hideContent);
adminRouter.post('/content/:id/remove', auditLog('content_remove', 'content'), removeContent);
adminRouter.post('/content/:id/restore', auditLog('content_restore', 'content'), restoreContent);
adminRouter.delete('/content/:id', deleteContent);

// Archive
adminRouter.get('/archive', listArchive);

// Creator analytics & search
adminRouter.get('/creator/:id/analytics', getCreatorAnalytics);
adminRouter.get('/creator/:id/profile', getCreatorProfile);
adminRouter.get('/creator/:id/studio', getCreatorStudio);
adminRouter.get('/search/creators', searchCreators);

// Admin chat with creators
adminRouter.post('/chat/send', adminSendMessage);
adminRouter.get('/chat/conversations', adminGetConversations);
adminRouter.get('/chat/:creatorId', adminGetMessages);

// Admin ban request (admin requests superadmin to ban a channel)
adminRouter.post('/creator/:id/ban-request', requestBanChannel);

// Audit logs
adminRouter.get('/audit-logs', listAuditLogs);

// Notifications
adminRouter.get('/notifications', listNotifications);
adminRouter.post('/notifications/:id/read', markNotificationRead);

// Admin requests (signup approvals, forgot-password activations)
adminRouter.get('/requests', listRequests);

// ─── SuperAdmin-only routes ──────────────────────────────────────────────────
adminRouter.post('/approve-signup', requireSuperAdmin, auditLog('signup_approved', 'admin'), approveSignup);
adminRouter.post('/reject-signup', requireSuperAdmin, auditLog('signup_rejected', 'admin'), rejectSignup);
adminRouter.post('/forgot-password-approve', requireSuperAdmin, auditLog('forgot_password_approved', 'admin'), forgotPasswordApprove);
adminRouter.delete('/remove-admin/:id', requireSuperAdmin, auditLog('admin_remove', 'admin'), removeAdmin);
adminRouter.get('/list-admins', requireSuperAdmin, listAdmins);
adminRouter.post('/creator/:id/ban', requireSuperAdmin, banChannel);
adminRouter.post('/creator/:id/unban', requireSuperAdmin, unbanChannel);
adminRouter.patch('/content/:id/stats', requireSuperAdmin, updateContentStats);
adminRouter.patch('/creator/:id/stats', requireSuperAdmin, updateCreatorStats);
adminRouter.post('/unlock-admin/:id', requireSuperAdmin, auditLog('admin_unlock', 'admin'), unlockAdmin);
adminRouter.post('/analytics/aggregate', requireSuperAdmin, runAggregation);

export default adminRouter;
