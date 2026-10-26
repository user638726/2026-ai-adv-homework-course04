// Startup checks for configuration that is harmless on a developer machine but unsafe in production.
// Pure function over an env object so it can be tested without touching process.env.

const PLACEHOLDER_JWT_SECRET = 'your-jwt-secret-key-here';
const MIN_JWT_SECRET_LENGTH = 32;

const DEFAULT_ADMIN_PASSWORD = '12345678';
const MIN_ADMIN_PASSWORD_LENGTH = 12;

// Public ECPay staging credentials that src/utils/ecpay.js falls back to when nothing is configured
const ECPAY_STAGING_DEFAULTS = Object.freeze({
  ECPAY_MERCHANT_ID: '3002607',
  ECPAY_HASH_KEY: 'pwFHCqoQZGmho4w6',
  ECPAY_HASH_IV: 'EkRm7iFT261dpevs'
});

function checkJwtSecret(env, isProduction, errors, warnings) {
  const secret = env.JWT_SECRET;
  if (!secret) {
    errors.push('JWT_SECRET is not set');
    return;
  }

  const isPlaceholder = secret === PLACEHOLDER_JWT_SECRET;
  if (isProduction && (isPlaceholder || secret.length < MIN_JWT_SECRET_LENGTH)) {
    errors.push(`JWT_SECRET must be a unique secret of at least ${MIN_JWT_SECRET_LENGTH} characters in production`);
  } else if (isPlaceholder) {
    warnings.push('JWT_SECRET is still the placeholder from .env.example; anyone who has read it can forge tokens');
  }
}

function checkAdminAccount(env, isProduction, errors, warnings) {
  const password = env.ADMIN_PASSWORD;

  if (!isProduction) {
    if (!password || password === DEFAULT_ADMIN_PASSWORD) {
      warnings.push('ADMIN_PASSWORD is not set or is the documented default, so the seeded admin account has a publicly known password (development only)');
    }
    return;
  }

  if (!env.ADMIN_EMAIL) {
    errors.push('ADMIN_EMAIL must be set explicitly in production');
  }
  if (!password) {
    errors.push('ADMIN_PASSWORD must be set explicitly in production');
  } else if (password === DEFAULT_ADMIN_PASSWORD || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    errors.push(`ADMIN_PASSWORD must not be the documented default and must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters in production`);
  }
}

function checkEcpay(env, errors, warnings) {
  const ecpayEnv = env.ECPAY_ENV;

  if (ecpayEnv !== 'production' && ecpayEnv !== 'staging') {
    errors.push('ECPAY_ENV must be set to "production" or "staging" in production');
    return;
  }

  if (ecpayEnv === 'staging') {
    warnings.push('ECPAY_ENV=staging: payments go to the ECPay test environment and no real money is collected');
    return;
  }

  for (const [name, stagingValue] of Object.entries(ECPAY_STAGING_DEFAULTS)) {
    if (!env[name]) {
      errors.push(`${name} must be set in production`);
    } else if (env[name] === stagingValue) {
      errors.push(`${name} is the public ECPay staging value; use the credentials of the production merchant`);
    }
  }
}

function validateEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProduction = env.NODE_ENV === 'production';

  checkJwtSecret(env, isProduction, errors, warnings);
  checkAdminAccount(env, isProduction, errors, warnings);
  if (isProduction) {
    checkEcpay(env, errors, warnings);
  }

  return { errors, warnings };
}

module.exports = { validateEnvironment };
