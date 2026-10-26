// Shared input validators for request bodies

const MAX_EMAIL_LENGTH = 254;

// Labels in the domain part cannot contain a dot, so every dot is a fixed split point.
// That keeps the pattern free of overlapping quantifiers and the match time linear;
// the previous /^[^\s@]+@[^\s@]+\.[^\s@]+$/ backtracked quadratically on "a@....... ".
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const MAX_PAGE = 1000000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === 'string';
}

function isValidEmail(value) {
  return typeof value === 'string'
    && value.length <= MAX_EMAIL_LENGTH
    && EMAIL_PATTERN.test(value);
}

/**
 * Parse a positive integer from a number or an integer string.
 * Returns null for anything else ("3abc", 1.9, [5], 0, -1) and for values
 * beyond Number.MAX_SAFE_INTEGER.
 */
function parsePositiveInteger(value) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// Query values arrive as strings, arrays or objects (?page[x]=1). Anything that is not a
// digit string below `min` falls back; digit strings above `max` are capped.
function parseBoundedInteger(value, { min = 1, max, fallback }) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed < min ? fallback : Math.min(parsed, max);
}

/**
 * Read ?page and ?limit for list endpoints. Invalid values use the defaults, so a
 * malformed query never turns into a 500 from an out-of-range SQLite offset.
 */
function parsePagination(query, { defaultLimit = 10, maxLimit = 100 } = {}) {
  const page = parseBoundedInteger(query.page, { max: MAX_PAGE, fallback: 1 });
  const limit = parseBoundedInteger(query.limit, { max: maxLimit, fallback: defaultLimit });
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Strict variant of parsePagination for endpoints that reject a bad ?page or ?limit.
 * A missing value uses the default and a limit above the maximum is capped, but anything
 * that is not a positive integer string (0, -1, 1.5, abc, empty, repeated or nested
 * parameters) makes the whole query invalid. Returns null in that case.
 */
function parseStrictPagination(query, { defaultLimit = 10, maxLimit = 100 } = {}) {
  const page = query.page === undefined
    ? 1
    : parseBoundedInteger(query.page, { max: MAX_PAGE, fallback: null });
  const limit = query.limit === undefined
    ? defaultLimit
    : parseBoundedInteger(query.limit, { max: maxLimit, fallback: null });

  if (page === null || limit === null) return null;
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = {
  isNonEmptyString,
  isOptionalString,
  isValidEmail,
  parsePositiveInteger,
  parsePagination,
  parseStrictPagination
};
