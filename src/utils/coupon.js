// Coupon rules. Like the Shipping module this has no dependency on Express or the database:
// it only turns a product subtotal and a coupon code into a discount.

const COUPON_ERRORS = Object.freeze({
  INVALID: 'COUPON_INVALID',
  EXPIRED: 'COUPON_EXPIRED',
  MIN_SUBTOTAL: 'COUPON_MIN_SUBTOTAL'
});

// 'fixed' takes `amount` off; 'percent' takes `percent`% off, at most `maxDiscount`.
// `minSubtotal` is compared with the subtotal before the discount.
const COUPONS = Object.freeze({
  FLOWER100: Object.freeze({ type: 'fixed', amount: 100, minSubtotal: 800 }),
  SPRING10: Object.freeze({ type: 'percent', percent: 10, maxDiscount: 300 }),
  SUMMER50: Object.freeze({ type: 'fixed', amount: 50, expired: true })
});

// ASCII only on purpose: toUpperCase() folds look-alikes ("ſ" becomes "S", the ligature "ﬂ"
// becomes "FL"), so "ſpring10" would otherwise be accepted as SPRING10.
const COUPON_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

class CouponError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CouponError';
    this.code = code;
  }
}

/**
 * Normalize user input to the canonical (upper case) code.
 * Returns null when no coupon was given (undefined, null, blank) and throws
 * TypeError for non-strings, CouponError for strings that cannot be a coupon code.
 */
function normalizeCouponCode(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('couponCode 必須為字串');
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!COUPON_CODE_PATTERN.test(trimmed)) {
    // The message does not repeat the input
    throw new CouponError(COUPON_ERRORS.INVALID, '優惠碼無效');
  }
  return trimmed.toUpperCase();
}

function calculateDiscount(rule, subtotal) {
  if (rule.type === 'percent') {
    // floor((x + 50) / 100) rounds half up in integer arithmetic, so there is no float error
    const percentOff = Math.floor((subtotal * rule.percent + 50) / 100);
    return Math.min(percentOff, rule.maxDiscount);
  }
  return rule.amount;
}

/**
 * Apply an optional coupon to a product subtotal.
 * Returns { couponCode, discount, discountedSubtotal }; couponCode is null when none was used.
 * Throws CouponError for an unknown, expired or not yet eligible coupon.
 */
function applyCoupon({ subtotal, couponCode }) {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new TypeError('subtotal 必須為非負整數');
  }

  const code = normalizeCouponCode(couponCode);
  if (code === null) {
    return Object.freeze({ couponCode: null, discount: 0, discountedSubtotal: subtotal });
  }

  if (!Object.prototype.hasOwnProperty.call(COUPONS, code)) {
    throw new CouponError(COUPON_ERRORS.INVALID, '優惠碼無效');
  }
  const rule = COUPONS[code];

  if (rule.expired) {
    throw new CouponError(COUPON_ERRORS.EXPIRED, `優惠碼 ${code} 已失效`);
  }
  if (rule.minSubtotal && subtotal < rule.minSubtotal) {
    throw new CouponError(
      COUPON_ERRORS.MIN_SUBTOTAL,
      `優惠碼 ${code} 需商品小計滿 ${rule.minSubtotal} 元才能使用`
    );
  }

  // A discount can never be larger than what is being bought
  const discount = Math.min(calculateDiscount(rule, subtotal), subtotal);
  return Object.freeze({ couponCode: code, discount, discountedSubtotal: subtotal - discount });
}

module.exports = {
  COUPONS,
  COUPON_ERRORS,
  CouponError,
  normalizeCouponCode,
  applyCoupon
};
