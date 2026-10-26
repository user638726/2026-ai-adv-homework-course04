const { validateEnvironment } = require('../src/utils/envValidation');

// A production environment that passes every check; individual tests override one variable.
function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(40),
    ADMIN_EMAIL: 'owner@shop.example',
    ADMIN_PASSWORD: 'a-long-unique-passphrase',
    ECPAY_ENV: 'production',
    ECPAY_MERCHANT_ID: '2000132',
    ECPAY_HASH_KEY: 'prodHashKey12345',
    ECPAY_HASH_IV: 'prodHashIV123456',
    ...overrides
  };
}

describe('validateEnvironment', () => {
  it('requires JWT_SECRET in every environment', () => {
    expect(validateEnvironment({}).errors).toContain('JWT_SECRET is not set');
    expect(validateEnvironment({ NODE_ENV: 'development' }).errors).toContain('JWT_SECRET is not set');
    expect(validateEnvironment({ NODE_ENV: 'production' }).errors).toContain('JWT_SECRET is not set');
  });

  it('accepts a development environment that only sets JWT_SECRET, with warnings', () => {
    const { errors, warnings } = validateEnvironment({ JWT_SECRET: 'dev-secret' });

    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/ADMIN_PASSWORD/);
  });

  it('warns about a placeholder JWT_SECRET outside production', () => {
    const { errors, warnings } = validateEnvironment({ JWT_SECRET: 'your-jwt-secret-key-here' });

    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/JWT_SECRET/);
  });

  it('does not warn about the admin account when it is configured explicitly', () => {
    const { warnings } = validateEnvironment({
      JWT_SECRET: 'dev-secret',
      ADMIN_PASSWORD: 'a-long-unique-passphrase'
    });

    expect(warnings.join('\n')).not.toMatch(/ADMIN_PASSWORD/);
  });

  it('accepts a fully configured production environment', () => {
    expect(validateEnvironment(productionEnv())).toEqual({ errors: [], warnings: [] });
  });

  describe('production', () => {
    it.each([
      ['a missing JWT_SECRET', { JWT_SECRET: undefined }, 'JWT_SECRET is not set'],
      ['the placeholder JWT_SECRET', { JWT_SECRET: 'your-jwt-secret-key-here' }, /JWT_SECRET/],
      ['a short JWT_SECRET', { JWT_SECRET: 'short' }, /JWT_SECRET/],
      ['a missing ADMIN_EMAIL', { ADMIN_EMAIL: undefined }, /ADMIN_EMAIL/],
      ['a missing ADMIN_PASSWORD', { ADMIN_PASSWORD: undefined }, /ADMIN_PASSWORD/],
      ['the default ADMIN_PASSWORD', { ADMIN_PASSWORD: '12345678' }, /ADMIN_PASSWORD/],
      ['a short ADMIN_PASSWORD', { ADMIN_PASSWORD: 'short-pw' }, /ADMIN_PASSWORD/],
      ['an unset ECPAY_ENV', { ECPAY_ENV: undefined }, /ECPAY_ENV/],
      ['an unknown ECPAY_ENV', { ECPAY_ENV: 'prod' }, /ECPAY_ENV/],
      ['a missing ECPAY_MERCHANT_ID', { ECPAY_MERCHANT_ID: undefined }, /ECPAY_MERCHANT_ID/],
      ['a missing ECPAY_HASH_KEY', { ECPAY_HASH_KEY: undefined }, /ECPAY_HASH_KEY/],
      ['a missing ECPAY_HASH_IV', { ECPAY_HASH_IV: undefined }, /ECPAY_HASH_IV/],
      ['the public staging MerchantID', { ECPAY_MERCHANT_ID: '3002607' }, /staging/],
      ['the public staging HashKey', { ECPAY_HASH_KEY: 'pwFHCqoQZGmho4w6' }, /staging/],
      ['the public staging HashIV', { ECPAY_HASH_IV: 'EkRm7iFT261dpevs' }, /staging/]
    ])('rejects %s', (_label, overrides, expected) => {
      const { errors } = validateEnvironment(productionEnv(overrides));

      expect(errors.length).toBeGreaterThan(0);
      if (typeof expected === 'string') {
        expect(errors).toContain(expected);
      } else {
        expect(errors.join('\n')).toMatch(expected);
      }
    });

    it('allows ECPAY_ENV=staging with the default test credentials, but warns', () => {
      const { errors, warnings } = validateEnvironment(productionEnv({
        ECPAY_ENV: 'staging',
        ECPAY_MERCHANT_ID: undefined,
        ECPAY_HASH_KEY: undefined,
        ECPAY_HASH_IV: undefined
      }));

      expect(errors).toEqual([]);
      expect(warnings.join('\n')).toMatch(/staging/);
    });

    it('reports every problem at once', () => {
      const { errors } = validateEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'short' });

      expect(errors.length).toBeGreaterThanOrEqual(4);
    });
  });
});
