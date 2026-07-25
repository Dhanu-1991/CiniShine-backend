import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

console.log('--- TESTING EMAIL TRANSPORTS ---');
console.log('EMAIL_USER:', process.env.EMAIL_USER);
console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? 'SET' : 'NOT SET');
console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET' : 'NOT SET');
console.log('RESEND_FROM:', process.env.RESEND_FROM);

if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('\n--- TESTING RESEND ---');
    try {
        const fromAddr = process.env.RESEND_FROM || 'Watchinit <onboarding@resend.dev>';
        console.log('Sending test email via Resend from:', fromAddr, 'to:', process.env.EMAIL_USER);
        const res = await resend.emails.send({
            from: fromAddr,
            to: process.env.EMAIL_USER || 'admin@watchinit.com',
            subject: 'Test Resend Delivery',
            html: '<p>Test Resend email delivery</p>'
        });
        console.log('Resend send response:', JSON.stringify(res));
    } catch (e) {
        console.error('Resend Exception:', e);
    }
}

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    console.log('\n--- TESTING NODEMAILER SMTP ---');
    const isGmail = process.env.EMAIL_USER.includes('@gmail.com');
    const hostsToTry = [
        { host: process.env.SMTP_HOST || (isGmail ? 'smtp.gmail.com' : 'smtp.hostinger.com'), port: 587, secure: false },
        { host: process.env.SMTP_HOST || (isGmail ? 'smtp.gmail.com' : 'smtp.hostinger.com'), port: 465, secure: true },
        { host: process.env.SMTP_HOST || (isGmail ? 'smtp.gmail.com' : 'smtp.gmail.com'), port: 465, secure: true },
    ];

    for (const h of hostsToTry) {
        console.log(`Testing ${h.host}:${h.port} (secure=${h.secure})...`);
        const transporter = nodemailer.createTransport({
            host: h.host,
            port: h.port,
            secure: h.secure,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
            tls: { rejectUnauthorized: false }
        });

        try {
            await transporter.verify();
            console.log(`✅ Nodemailer SMTP SUCCESS on ${h.host}:${h.port}!`);
            break;
        } catch (err) {
            console.error(`❌ ${h.host}:${h.port} failed:`, err.message);
        }
    }
}
