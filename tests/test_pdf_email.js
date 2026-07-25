import dotenv from 'dotenv';
import { Resend } from 'resend';
import { generateSettlementPdf } from '../utils/pdfGenerator.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

async function run() {
    console.log('--- GENERATING PDF INVOICE ---');
    const pdfBuffer = await generateSettlementPdf({
        creatorName: 'Dhanush Kumar',
        userName: 'dhanush',
        userHandle: '@dhanush',
        gstin: '29ABCDE1234F1Z5',
        netAmount: 1500,
        grossAmount: 2000,
        payoutMonth: '2026-07',
        totalSellingPrice: 2000,
        totalBasePrice: 1694.92,
        totalGstCollected: 305.08,
        totalPlatformCommission: 640,
        totalGstOnCommission: 115.20,
        totalTdsDeducted: 1.69,
        totalTcsDeducted: 16.95,
        bankDetails: {
            accountHolderName: 'Dhanush Kumar',
            bankName: 'HDFC Bank',
            accountNumber: '••••5678',
            ifscCode: 'HDFC0001234'
        }
    });

    console.log('PDF Generated! Size:', pdfBuffer.length, 'bytes');

    const resend = new Resend(process.env.RESEND_API_KEY);
    const to = 'dhanushkumarvr@gmail.com'; // Resend sandbox verified recipient
    const from = process.env.RESEND_FROM || 'Watchinit <onboarding@resend.dev>';

    console.log(`Sending to ${to} from ${from}...`);

    const response = await resend.emails.send({
        from,
        to,
        subject: '[Watchinit] Payout Settlement Processed: 2026-07',
        html: `<h2>Payout Settlement Processed</h2><p>Attached is your official settlement PDF invoice.</p>`,
        attachments: [
            {
                filename: 'Tax_Invoice_2026-07.pdf',
                content: pdfBuffer,
            }
        ]
    });

    console.log('Resend Response:', JSON.stringify(response));
}

run().catch(console.error);
