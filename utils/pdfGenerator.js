/**
 * pdfGenerator.js — Ultra-Clean PDF Tax Invoice Generator using pdfkit
 * Generates beautiful, 100% valid PDF documents for Settlement Tax Invoices.
 */
import PDFDocument from 'pdfkit';
import { calculateTaxBreakdown } from './taxCalculator.js';

export function generateSettlementPdf({
  creatorName,
  userName,
  userHandle,
  gstin,
  netAmount,
  grossAmount,
  payoutMonth,
  totalSellingPrice,
  totalBasePrice,
  totalGstCollected,
  totalPlatformCommission,
  totalGstOnCommission,
  totalTdsDeducted,
  totalTcsDeducted,
  totalTransferredToWallet1 = 0,
  periodStart = null,
  periodEnd = null,
  bankDetails = {}
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const cName = creatorName || userName || 'Creator';
      const uName = userName || cName;
      const handleStr = userHandle ? (userHandle.startsWith('@') ? userHandle : `@${userHandle}`) : '@creator';
      const gstStr = gstin && String(gstin).trim().length > 3 ? String(gstin).trim().toUpperCase() : 'N/A (Unregistered)';

      // STRICT LEDGER VALUES ONLY — ZERO BACKTRACING / RATIO SCALING
      let sellingNum = Number(totalSellingPrice || 0);
      let baseNum = Number(totalBasePrice || 0);
      let gstNum = Number(totalGstCollected || 0);
      let commNum = Number(totalPlatformCommission || 0);
      let commGstNum = Number(totalGstOnCommission || 0);
      let tdsNum = Number(totalTdsDeducted || 0);
      let tcsNum = Number(totalTcsDeducted || 0);
      let transferredToW1Num = Number(totalTransferredToWallet1 || 0);
      let netNum = Number(netAmount !== undefined ? netAmount : (grossAmount || 0));

      const selling = sellingNum.toFixed(2);
      const base = baseNum.toFixed(2);
      const gst = gstNum.toFixed(2);
      const comm = commNum.toFixed(2);
      const commGst = commGstNum.toFixed(2);
      const tds = tdsNum.toFixed(2);
      const tcs = tcsNum.toFixed(2);
      const transferredToW1 = transferredToW1Num.toFixed(2);
      const net = netNum.toFixed(2);
      const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

      // Format Date Window with Time in IST (e.g. 12/06/26 05:37 pm to 12/06/26 05:54 pm)
      const formatDateTime = (d) => {
        if (!d) return null;
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return null;
        const dStr = dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Kolkata' });
        const tStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
        return `${dStr} ${tStr.toLowerCase()}`;
      };

      const windowStartStr = formatDateTime(periodStart) || 'Account Creation';
      const windowEndStr = formatDateTime(periodEnd || new Date());
      const calculationWindowStr = `${windowStartStr} to ${windowEndStr}`;

      // Header Banner
      doc.rect(40, 40, 515, 65).fill('#111827');
      doc.fillColor('#10B981').fontSize(16).font('Helvetica-Bold').text('WATCHINIT TECHNOLOGIES PRIVATE LIMITED', 55, 54);
      doc.fillColor('#9CA3AF').fontSize(11).font('Helvetica-Bold').text('OFFICIAL SETTLEMENT TAX INVOICE', 55, 78);

      // Metadata section
      let y = 130;
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text('CREATOR & ACCOUNT DETAILS', 40, y);
      y += 16;
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#E5E7EB').stroke();
      y += 12;

      const addMetaRow = (label, val) => {
        doc.fillColor('#4B5563').fontSize(9.5).font('Helvetica').text(label, 40, y);
        doc.fillColor('#111827').fontSize(9.5).font('Helvetica-Bold').text(val, 200, y);
        y += 18;
      };

      addMetaRow('Profile / Channel Name:', cName);
      addMetaRow('User Name:', uName);
      addMetaRow('Profile Handle:', handleStr);
      addMetaRow('Creator GSTIN:', gstStr);
      addMetaRow('Payout Month / Period:', payoutMonth);
      addMetaRow('Payout Window (Date & Time):', calculationWindowStr);
      addMetaRow('Invoice Issue Date:', dateStr);

      y += 10;
      // Revenue & Tax Table Header
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text('ITEMIZED REVENUE & TAX BREAKDOWN', 40, y);
      y += 16;
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#E5E7EB').stroke();
      y += 10;

      // Table Header Box
      doc.rect(40, y, 515, 24).fill('#F3F4F6');
      doc.fillColor('#374151').fontSize(9).font('Helvetica-Bold').text('DESCRIPTION / LINE ITEM', 50, y + 7);
      doc.text('AMOUNT (INR)', 440, y + 7, { align: 'right', width: 100 });
      y += 28;

      const addTableRow = (label, amt, color = '#111827', isBold = false) => {
        doc.fillColor(color).fontSize(9.5).font(isBold ? 'Helvetica-Bold' : 'Helvetica').text(label, 50, y);
        doc.text(`INR ${amt}`, 440, y, { align: 'right', width: 100 });
        y += 18;
      };

      addTableRow('Gross Sales Collected (GST Incl.)', selling, '#111827', true);
      addTableRow('Base Price (Excl. 18% GST)', base, '#4B5563');
      addTableRow('GST Collected on Base Price (18%)', gst, '#4B5563');
      addTableRow('Platform Commission (32% Cut)', `- ${comm}`, '#7C3AED');
      addTableRow('GST on Platform Commission (18%)', `- ${commGst}`, '#7C3AED');
      addTableRow('TDS Deducted (Sec 194-O, 0.1%)', `- ${tds}`, '#DC2626');
      addTableRow('TCS Deducted (Sec 206C, 1.0%)', `- ${tcs}`, '#DC2626');

      if (transferredToW1Num > 0) {
        addTableRow('Transferred to Wallet 1 (Self Transfer)', `- ${transferredToW1}`, '#D97706');
      }

      y += 6;
      doc.rect(40, y, 515, 32).fill('#ECFDF5');
      doc.fillColor('#065F46').fontSize(11).font('Helvetica-Bold').text('NET CREATOR PAYOUT TRANSFERRED', 50, y + 10);
      doc.text(`INR ${net}`, 440, y + 10, { align: 'right', width: 100 });
      y += 44;

      // Bank Details Section
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text('BANK SETTLEMENT DESTINATION', 40, y);
      y += 16;
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#E5E7EB').stroke();
      y += 12;

      let rawAcc = bankDetails.accountNumber || '';
      let rawBank = bankDetails.bankName || '';
      let displayBank = rawBank;
      let displayAcc = rawAcc;

      // Smart auto-fix: If bankName is numeric/masked and accountNumber is text, swap them
      if (rawBank && rawAcc && (/^\d+$/.test(rawBank.replace(/•/g, '')) || rawBank.includes('••••')) && /^[A-Za-z\s]+$/.test(rawAcc)) {
        displayBank = rawAcc;
        displayAcc = rawBank;
      }
      if (displayAcc && !displayAcc.includes('••••') && displayAcc.length > 4) {
        displayAcc = '••••' + displayAcc.slice(-4);
      }

      addMetaRow('Account Holder Name:', bankDetails.accountHolderName || cName);
      addMetaRow('Bank Name:', displayBank || 'Registered Settlement Bank');
      addMetaRow('Bank Account No.:', displayAcc || '•••• Stored Encrypted');
      addMetaRow('IFSC Code:', bankDetails.ifscCode || 'Stored on File');

      y += 18;
      doc.fillColor('#6B7280').fontSize(8).font('Helvetica');
      doc.text('Compliance Note: GST collected from buyers is subject to creator self-filing. TDS and TCS deductions are deposited with IT Dept and reflect in Form 26AS / AIS.', 40, y, { width: 515, lineGap: 4 });
      y = doc.y + 12;
      doc.text('This document is an official computer-generated financial settlement tax invoice issued by Watchinit Technologies Private Limited.', 40, y, { width: 515 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
