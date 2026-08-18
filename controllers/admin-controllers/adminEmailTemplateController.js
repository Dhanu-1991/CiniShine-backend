import EmailTemplate from '../../models/emailTemplate.model.js';

const DEFAULT_TEMPLATES = [
    {
        templateId: 'platform_updates',
        name: '✨ Platform Updates (Wallets, Engagement, Rentals & Referrals)',
        category: 'Announcements',
        icon: '✨',
        subject: '✨ Important Platform Updates: Wallets, Engagement Payouts, Rentals & Referrals — Watchin It',
        body: `We've glad to announce you that we have rolled out exciting new features and monetization upgrades on Watchin It, designed to empower creators and viewers alike. Here is everything you need to know.\n\n1. Wallet & Payout Balance System\n\nWallet: Your in app balance for renting content and purchasing future subscriptions. Easily rechargeable via UPI or Net Banking, secured by a 4 digit PIN. This wallet is non withdrawable.\n\nPayout Balance: Receives all your content earnings, engagement payouts, and referral rewards after tax and platform cuts. Eligible balances are automatically paid out to your verified bank account at month end, so there's no need for manual withdrawal requests.\n\n2. Engagement Payouts (CPM Earnings)\n\nEarn money directly from audience engagement. Creators are rewarded with CPM earnings based on total views, watch time, completion rates, and video performance. All approved engagement earnings are credited directly to your Payout Balance.\n\n3. Content Rentals (Pay Per View)\n\nMonetize your premium videos and audio tracks with customizable rental pricing. Viewers unlock a 48 hour viewing access window. Your net earnings, after a 32% platform fee, 18% GST on the platform's cut, 0.1% TDS, and 1% TCS, go straight to your Payout Balance.\n\n4. Referral Program\n\nInvite fellow creators to join Watchin It. Earn ₹25 in your Payout Balance for every approved creator referral who signs up and uploads copyright-free film content, while your referred friend receives ₹25 in their Wallet to explore and rent content on the platform.\n\nLog in to your Watchin It dashboard today to explore these new features and start creating and monetizing.\n\nhttps://watchinit.com\n\nBest wishes,\nWatchin It\nHouse of Cinema`,
        isSystem: true,
    },
    {
        templateId: 'welcome',
        name: '👋 Welcome to WatchInit',
        category: 'Onboarding',
        icon: '👋',
        subject: 'Welcome to WatchInit — Account Getting Started Guide',
        body: `Welcome to WatchInit! Your creator account has been successfully set up.\n\nTo get started, please complete your profile details, upload your first content, and configure your 4-digit Payment PIN in your Wallet settings.\n\nIf you have any questions or require assistance, please contact our support team.`,
        isSystem: true,
    },
    {
        templateId: 'guideline_reminder',
        name: '⚠️ Community Guidelines Reminder',
        category: 'Policy',
        icon: '⚠️',
        subject: 'Important Reminder: WATCHIN IT Community & Content Guidelines',
        body: `Please review our Community & Content Guidelines to ensure your uploaded media complies with platform policies.\n\nEnsure all videos, audio tracks, and posts adhere to copyright laws and community standards. Repeated violations may result in content removal or account suspension.`,
        isSystem: true,
    },
    {
        templateId: 'great_content',
        name: '⭐ Great Content Performance Notice',
        category: 'Engagement',
        icon: '⭐',
        subject: 'Account Advisory: High Channel Performance & Payout Readiness',
        body: `Your channel has shown strong audience engagement and watch time over recent weeks.\n\nPlease ensure your KYC verification details (bank account number, IFSC code, and account proof) are complete and up to date to guarantee automated month-end payouts.`,
        isSystem: true,
    },
    {
        templateId: 'kyc_reminder',
        name: '🆔 KYC & Verification Notice',
        category: 'Monetization',
        icon: '🆔',
        subject: 'Action Required: Complete Your KYC Verification for Bank Payouts',
        body: `To ensure uninterrupted automated month-end payouts to your bank account, please upload and verify your KYC documents (bank details, IFSC code, account holder name, and passbook/cheque proof).\n\nUnverified accounts will have their earnings securely retained in Payout Balance until verification is completed. Log in to your account and complete your KYC submission today.`,
        isSystem: true,
    },
    {
        templateId: 'copyright_notice',
        name: '©️ Copyright Compliance Notice',
        category: 'Policy',
        icon: '©️',
        subject: 'Important Notice: Content Copyright & Rights Verification',
        body: `We are reaching out regarding content licensing and copyright compliance for uploaded media on your channel.\n\nPlease review your content catalog to confirm all background music, visual assets, and media are properly licensed or original. Contact support if you need further clarification.`,
        isSystem: true,
    },
    {
        templateId: 'inactive_creator_nudge',
        name: '🔔 Inactive Creator — Upload Reminder',
        category: 'Re-engagement',
        icon: '🔔',
        subject: 'We miss you on Watchin It! Your audience is waiting',
        body: `It's been a while since you last uploaded content on Watchin It, and we wanted to check in!\n\nYour channel still has viewers discovering your existing content, and they'd love to see more from you. Here are a few reasons to come back:\n\n• 💰 Earn engagement payouts (CPM) on every view your content receives\n• 🎬 Monetize premium content with our Pay-Per-View rental system\n• 👥 Grow your fanbase — your existing followers are still active\n• 🎁 Refer other creators and earn ₹25 per approved referral\n\nYour creative voice matters. Whether it's a short frame, a full video, an audio track, or a simple post — every upload brings you closer to your audience.\n\nLog in and upload your next piece today:\nhttps://watchinit.com/upload\n\nWe can't wait to see what you create next!\n\nBest wishes,\nWatchin It\nHouse of Cinema`,
        isSystem: true,
    },
    {
        templateId: 'custom',
        name: '✏️ Custom Email',
        category: 'General',
        icon: '✏️',
        subject: 'Announcement from Watchin It',
        body: 'Write your announcement message here...',
        isSystem: true,
    },
];

export const seedDefaultTemplates = async () => {
    try {
        for (const tpl of DEFAULT_TEMPLATES) {
            await EmailTemplate.findOneAndUpdate(
                { templateId: tpl.templateId },
                { $set: tpl },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }
        console.log('[SEED] Default email templates verified/inserted');
    } catch (err) {
        console.error('[SEED_ERROR]', err);
    }
};

export const listTemplates = async (req, res) => {
    try {
        await seedDefaultTemplates();
        const templates = await EmailTemplate.find().sort({ isSystem: -1, name: 1 }).lean();
        res.json({ success: true, templates });
    } catch (err) {
        console.error('[LIST_TEMPLATES]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch templates' });
    }
};

export const getTemplate = async (req, res) => {
    try {
        const template = await EmailTemplate.findById(req.params.id).lean();
        if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch template' });
    }
};

export const createTemplate = async (req, res) => {
    try {
        const { name, category, icon, subject, body } = req.body;
        if (!name || !subject || !body) {
            return res.status(400).json({ success: false, message: 'Name, subject, and body are required' });
        }
        
        let baseTemplateId = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        let templateId = baseTemplateId;
        let counter = 1;
        while (await EmailTemplate.findOne({ templateId })) {
            templateId = `${baseTemplateId}_${counter}`;
            counter++;
        }

        const template = await EmailTemplate.create({
            templateId,
            name,
            category,
            icon,
            subject,
            body,
            isSystem: false,
            createdBy: req.admin._id
        });
        res.status(201).json({ success: true, template });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to create template' });
    }
};

export const updateTemplate = async (req, res) => {
    try {
        const { name, category, icon, subject, body } = req.body;
        const template = await EmailTemplate.findByIdAndUpdate(
            req.params.id,
            { name, category, icon, subject, body },
            { new: true, runValidators: true }
        );
        if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update template' });
    }
};

export const deleteTemplate = async (req, res) => {
    try {
        const template = await EmailTemplate.findById(req.params.id);
        if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
        if (template.isSystem) {
            return res.status(403).json({ success: false, message: 'Cannot delete system templates' });
        }
        await EmailTemplate.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Template deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete template' });
    }
};
