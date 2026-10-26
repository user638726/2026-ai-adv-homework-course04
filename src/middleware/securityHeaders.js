// Baseline response headers that do not depend on page content.
// No Content-Security-Policy here on purpose: the pages use inline scripts and CDN assets,
// so a policy needs its own pass once those are self-hosted.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

module.exports = securityHeaders;
