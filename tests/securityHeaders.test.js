const { app, request } = require('./setup');

describe('Security headers', () => {
  it.each([
    ['an API response', '/api/products'],
    ['a rendered page', '/'],
    ['a static asset', '/js/auth.js'],
    ['a 404 response', '/api/does-not-exist']
  ])('sets the baseline headers on %s', async (_label, url) => {
    const res = await request(app).get(url);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/api/products');

    expect(res.headers).not.toHaveProperty('x-powered-by');
  });
});
