import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const commonEmailDomains = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'
];

const commonTypos = {
  'gmai.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'yaho.com': 'yahoo.com',
  'outlok.com': 'outlook.com'
};

export function detectCommonEmailTypos(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return null;

  const domain = parts[1];
  const correctedDomain = commonTypos[domain.toLowerCase()];

  if (correctedDomain) {
    return {
      isTypo: true,
      suggestion: `${parts[0]}@${correctedDomain}`
    };
  }

  return { isTypo: false };
}


export async function validateEmailAddress(email) {
  const apiKey = process.env.ABSTRACT_API_KEY;
  const url = `https://emailvalidation.abstractapi.com/v1/?api_key=${apiKey}&email=${email}`;

  try {
    const response = await axios.get(url);
    const data = response.data;

    const { is_valid_format, is_mx_found, deliverability } = data;

    if (!is_valid_format.value) {
      console.log("❌ Invalid email format:", email);
      return { valid: false, reason: "Invalid email format" };
    }

    if (!is_mx_found.value) {
      console.log("❌ Email domain has no MX records:", email);
      return { valid: false, reason: "No MX records for domain" };
    }

    if (deliverability !== 'DELIVERABLE') {
      console.log("⚠️ Email not deliverable:", email);
      return { valid: false, reason: "Email undeliverable or unknown" };
    }

    console.log("✅ Email is valid:", email);
    return { valid: true, reason: "Email format, domain, and deliverability are OK" };
  } catch (error) {
    console.error("❌ Error verifying email:", error.message);
    return { valid: false, reason: "Error during API check" };
  }
}
