import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import KycDetails from '../../models/kycDetails.model.js';
import PrimaryWallet from '../../models/primaryWallet.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import { decryptBankDetails } from '../../utils/encryption.js';

// Setup S3 Client using env vars
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

export const getKycList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status;

        const query = {};
        if (status && status !== 'all') {
            query.kycStatus = status;
        }

        const kycList = await KycDetails.find(query)
            .populate('userId', 'userName channelName contact')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await KycDetails.countDocuments(query);

        // Map and format response
        const formattedKycList = await Promise.all(kycList.map(async (kyc) => {
            let decryptedBank = null;
            if (kyc.bankAccountNumberEncrypted) {
                decryptedBank = decryptBankDetails(kyc);
            }

            let presignedUrl = null;
            if (kyc.kycDocumentKey) {
                const command = new GetObjectCommand({
                    Bucket: process.env.S3_BUCKET,
                    Key: kyc.kycDocumentKey
                });
                presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 mins
            }

            return {
                _id: kyc._id,
                user: kyc.userId,
                bankDetails: decryptedBank,
                kycDocumentUrl: presignedUrl,
                kycDocumentType: kyc.kycDocumentType,
                kycStatus: kyc.kycStatus,
                submittedAt: kyc.submittedAt,
                createdAt: kyc.createdAt
            };
        }));

        res.status(200).json({
            success: true,
            kycList: formattedKycList,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching KYC list:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getWalletsList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search?.trim();

        let query = {};
        if (search) {
            const User = mongoose.model('User');
            const users = await User.find({
                $or: [
                    { userName: new RegExp(search, 'i') },
                    { contact: new RegExp(search, 'i') },
                    { channelName: new RegExp(search, 'i') }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);
            query = { userId: { $in: userIds } };
        }

        const wallets = await PrimaryWallet.find(query)
            .populate('userId', 'userName channelName contact')
            .sort({ balance: -1 })
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await PrimaryWallet.countDocuments(query);

        res.status(200).json({
            success: true,
            wallets,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching primary wallets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getSecondaryWalletsList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search?.trim();

        let query = {};
        if (search) {
            const User = mongoose.model('User');
            const users = await User.find({
                $or: [
                    { userName: new RegExp(search, 'i') },
                    { contact: new RegExp(search, 'i') },
                    { channelName: new RegExp(search, 'i') }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);
            query = { userId: { $in: userIds } };
        }

        const wallets = await SecondaryWallet.find(query)
            .populate('userId', 'userName channelName contact')
            .sort({ balance: -1 })
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await SecondaryWallet.countDocuments(query);

        res.status(200).json({
            success: true,
            wallets,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching secondary wallets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
