import dotenv from "dotenv";
dotenv.config();

const PROMAILER_URL = process.env.PROMAILER_URL || 'https://api.mailbridge.dev/v1/messages/send';
const PROMAILER_API_KEY = process.env.PROMAILER_API_KEY;

async function _fetch(...args) {
  if (globalThis.fetch) return fetch(...args);
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch(...args);
}

export async function sendOtpToEmail(to, otp) {
  if (!PROMAILER_API_KEY) {
    console.error('Promailer API key missing: set PROMAILER_API_KEY');
    return false;
  }

  const payload = {
    to: to,
    subject: 'Your OTP Code',
    html: `<p>Your OTP is <strong>${otp}</strong></p>`
  };

  try {
    const res = await _fetch(PROMAILER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PROMAILER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Promailer error:', res.status, body);
      return false;
    }

    console.log('OTP sent successfully via Promailer');
    return true;
  } catch (error) {
    console.error('Promailer request failed:', error);
    return false;
  }
}
