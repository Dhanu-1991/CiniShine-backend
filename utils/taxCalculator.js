/**
 * Tax Calculator — Single source of truth for all tax calculations
 *
 * WATCHINIT Tax Structure (per CA guidance):
 * - GST: 18% on base price (selling price is GST-inclusive)
 * - Platform Commission: 32% of SELLING PRICE
 * - GST on Commission: 18% of commission amount
 * - TDS: 0.1% of base price (excl. GST) — Section 194-O
 * - TCS: 1% of base price (excl. GST) — Section 206C(1H)
 * - Creator receives: sellingPrice - commission - gstOnCommission - TDS - TCS
 *
 * Example (₹1000 selling price):
 *   Base: ₹847.46 | GST: ₹152.54 | Commission: ₹320
 *   GST on Comm: ₹57.60 | TDS: ₹0.85 | TCS: ₹8.47
 *   Creator gets: ₹613.08
 */

const GST_RATE = 0.18;                 // 18% GST
const PLATFORM_COMMISSION_RATE = 0.32; // 32% of selling price
const TDS_RATE = 0.001;                // 0.1% of base price (excl. GST)
const TCS_RATE = 0.01;                 // 1% of base price (excl. GST)
const GST_ON_COMMISSION_RATE = 0.18;   // 18% GST on platform commission

/**
 * Round to 2 decimal places (paisa precision)
 */
function round2(n) {
    return Number(Math.round(n * 100) / 100);
}

/**
 * Calculate full tax breakdown for a PPV transaction.
 *
 * @param {number} sellingPrice — GST-inclusive price the buyer pays
 * @returns {Object} Full tax breakdown
 */
export function calculateTaxBreakdown(sellingPrice) {
    const basePrice = round2(sellingPrice / (1 + GST_RATE));
    const gstAmount = round2(sellingPrice - basePrice);

    const platformCommission = round2(sellingPrice * PLATFORM_COMMISSION_RATE);
    const gstOnCommission = round2(platformCommission * GST_ON_COMMISSION_RATE);

    const tdsAmount = round2(basePrice * TDS_RATE);
    const tcsAmount = round2(basePrice * TCS_RATE);

    const creatorPayout = round2(
        sellingPrice - platformCommission - gstOnCommission - tdsAmount - tcsAmount
    );

    return {
        sellingPrice: round2(sellingPrice),
        basePrice,
        gstAmount,
        platformCommission,
        gstOnCommission,
        tdsAmount,
        tcsAmount,
        creatorPayout,
    };
}

/**
 * Get base price from a GST-inclusive selling price
 */
export function getBasePrice(sellingPrice) {
    return round2(sellingPrice / (1 + GST_RATE));
}

/**
 * Get GST amount from a GST-inclusive selling price
 */
export function getGstAmount(sellingPrice) {
    return round2(sellingPrice - getBasePrice(sellingPrice));
}

export {
    GST_RATE,
    PLATFORM_COMMISSION_RATE,
    TDS_RATE,
    TCS_RATE,
    GST_ON_COMMISSION_RATE,
};
