/**
 * Migration Script: Old Wallet → PrimaryWallet + SecondaryWallet + KycDetails
 *
 * RUN ONCE: node backend/scripts/migrateWallets.js
 *
 * This script:
 * 1. Reads all documents from the old `wallets` collection
 * 2. For type='primary': creates a PrimaryWallet document
 * 3. For type='settlement': creates a SecondaryWallet + KycDetails document
 * 4. Updates all WalletTransaction records with walletType field
 * 5. Reports any errors/conflicts
 *
 * SAFE TO RE-RUN: Uses upsert, won't duplicate records.
 * DOES NOT delete old collection — do that manually after verification.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import PrimaryWallet from '../models/primaryWallet.model.js';
import SecondaryWallet from '../models/secondaryWallet.model.js';
import KycDetails from '../models/kycDetails.model.js';
import WalletTransaction from '../models/walletTransaction.model.js';

dotenv.config();

async function migrate() {
    console.log('🔄 Starting wallet migration...\n');

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Access old wallets collection directly (don't import old model to avoid schema conflicts)
    const db = mongoose.connection.db;
    const oldWallets = await db.collection('wallets').find({}).toArray();

    console.log(`Found ${oldWallets.length} old wallet documents\n`);

    const stats = {
        primaryCreated: 0,
        primarySkipped: 0,
        secondaryCreated: 0,
        secondarySkipped: 0,
        kycCreated: 0,
        kycSkipped: 0,
        txnUpdated: 0,
        errors: [],
    };

    for (const oldWallet of oldWallets) {
        try {
            if (oldWallet.type === 'primary') {
                // Migrate to PrimaryWallet
                const existing = await PrimaryWallet.findOne({ userId: oldWallet.userId });
                if (existing) {
                    stats.primarySkipped++;
                    continue;
                }

                await PrimaryWallet.create({
                    _id: oldWallet._id, // Preserve _id for WalletTransaction.walletId references
                    userId: oldWallet.userId,
                    balance: oldWallet.balance || 0,
                    currency: oldWallet.currency || 'INR',
                    createdAt: oldWallet.createdAt || new Date(),
                });
                stats.primaryCreated++;

                // Tag transactions
                await WalletTransaction.updateMany(
                    { walletId: oldWallet._id, walletType: { $exists: false } },
                    { $set: { walletType: 'primary' } }
                );

            } else if (oldWallet.type === 'settlement') {
                // Migrate to SecondaryWallet
                const existingWallet = await SecondaryWallet.findOne({ userId: oldWallet.userId });
                if (existingWallet) {
                    stats.secondarySkipped++;
                } else {
                    await SecondaryWallet.create({
                        _id: oldWallet._id,
                        userId: oldWallet.userId,
                        balance: oldWallet.balance || 0,
                        currency: oldWallet.currency || 'INR',
                        createdAt: oldWallet.createdAt || new Date(),
                    });
                    stats.secondaryCreated++;
                }

                // Migrate KYC fields to KycDetails (if any KYC data exists)
                const hasKycData = oldWallet.kycStatus && oldWallet.kycStatus !== 'not_started';
                if (hasKycData) {
                    const existingKyc = await KycDetails.findOne({ userId: oldWallet.userId });
                    if (existingKyc) {
                        stats.kycSkipped++;
                    } else {
                        await KycDetails.create({
                            userId: oldWallet.userId,
                            bankAccountNumberEncrypted: oldWallet.bankAccountNumberEncrypted,
                            bankAccountIv: oldWallet.bankAccountIv,
                            bankAccountTag: oldWallet.bankAccountTag,
                            bankNameEncrypted: oldWallet.bankNameEncrypted,
                            bankNameIv: oldWallet.bankNameIv,
                            bankNameTag: oldWallet.bankNameTag,
                            ifscCodeEncrypted: oldWallet.ifscCodeEncrypted,
                            ifscCodeIv: oldWallet.ifscCodeIv,
                            ifscCodeTag: oldWallet.ifscCodeTag,
                            accountHolderNameEncrypted: oldWallet.accountHolderNameEncrypted,
                            accountHolderNameIv: oldWallet.accountHolderNameIv,
                            accountHolderNameTag: oldWallet.accountHolderNameTag,
                            kycDocumentKey: oldWallet.kycDocumentKey,
                            kycDocumentType: oldWallet.kycDocumentType,
                            kycStatus: oldWallet.kycStatus,
                            submittedAt: oldWallet.createdAt || new Date(),
                        });
                        stats.kycCreated++;
                    }
                }

                // Tag transactions
                await WalletTransaction.updateMany(
                    { walletId: oldWallet._id, walletType: { $exists: false } },
                    { $set: { walletType: 'secondary' } }
                );
            }
        } catch (err) {
            stats.errors.push({ walletId: oldWallet._id?.toString(), type: oldWallet.type, error: err.message });
            console.error(`❌ Error migrating wallet ${oldWallet._id}:`, err.message);
        }
    }

    // Count untagged transactions (should be 0 after migration)
    const untagged = await WalletTransaction.countDocuments({ walletType: { $exists: false } });
    stats.txnUpdated = await WalletTransaction.countDocuments({ walletType: { $exists: true } });

    console.log('\n========== MIGRATION RESULTS ==========');
    console.log(`Primary wallets:    ${stats.primaryCreated} created, ${stats.primarySkipped} skipped`);
    console.log(`Secondary wallets:  ${stats.secondaryCreated} created, ${stats.secondarySkipped} skipped`);
    console.log(`KYC details:        ${stats.kycCreated} created, ${stats.kycSkipped} skipped`);
    console.log(`Transactions tagged: ${stats.txnUpdated}`);
    console.log(`Untagged remaining:  ${untagged}`);
    if (stats.errors.length > 0) {
        console.log(`\n❌ Errors: ${stats.errors.length}`);
        stats.errors.forEach(e => console.log(`  - ${e.type} wallet ${e.walletId}: ${e.error}`));
    } else {
        console.log(`\n✅ No errors!`);
    }
    console.log('========================================\n');

    if (untagged === 0) {
        console.log('✅ All transactions tagged. Migration complete.');
        console.log('   After verifying, you can drop the old `wallets` collection manually.');
    } else {
        console.log(`⚠️  ${untagged} transactions still untagged. Investigate before proceeding.`);
    }

    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Fatal migration error:', err);
    process.exit(1);
});
