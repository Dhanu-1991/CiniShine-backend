import dotenv from 'dotenv';
dotenv.config();
import { sendCustomEmail } from '../services/adminEmailService.js';

async function testResend() {
    console.log('--- TESTING RESEND ADMIN EMAIL SERVICE ---');
    console.log('Sending test custom email via Resend to delivered@resend.dev...');
    const result = await sendCustomEmail(
        'delivered@resend.dev',
        'Test Admin Notice from WatchInIt',
        'This is a verification test email ensuring Resend integration is operational and templates are synced.',
        'Creator',
        'SuperAdmin'
    );
    console.log('Resend sendCustomEmail returned:', result ? '✅ SUCCESS' : '❌ FAILED');
    process.exit(result ? 0 : 1);
}

testResend().catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
