import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import Content from '../models/content.model.js';
import User from '../models/user.model.js';

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Migrate Content display fields (only documents missing them)
        const contentResult = await Content.updateMany(
            { displayViews: { $exists: false } },
            [{
                $set: {
                    displayViews: { $ifNull: ['$views', 0] },
                    displayLikeCount: { $ifNull: ['$likeCount', 0] },
                    displayFansGained: { $ifNull: ['$fansGained', 0] },
                    displayTotalWatchTime: { $ifNull: ['$totalWatchTime', 0] }
                }
            }]
        );
        console.log(`Content migration: ${contentResult.modifiedCount} documents updated`);

        // Migrate User display fields (only documents missing them)
        const userResult = await User.updateMany(
            { displaySubscriberCount: { $exists: false } },
            [{
                $set: {
                    displaySubscriberCount: { $ifNull: ['$subscriberCount', 0] }
                }
            }]
        );
        console.log(`User migration: ${userResult.modifiedCount} documents updated`);

        console.log('Migration complete!');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
