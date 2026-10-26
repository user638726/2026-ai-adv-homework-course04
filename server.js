require('dotenv').config();

const { validateEnvironment } = require('./src/utils/envValidation');

// Validate before ./app is loaded: requiring it opens the database and seeds the admin account,
// which must not happen with the documented default password in production.
if (require.main === module) {
  const { errors, warnings } = validateEnvironment(process.env);
  warnings.forEach((message) => console.warn(`Warning: ${message}`));
  if (errors.length > 0) {
    errors.forEach((message) => console.error(`Fatal: ${message}`));
    process.exit(1);
  }
}

const app = require('./app');

const PORT = process.env.PORT || 3001;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`ECPay environment: ${process.env.ECPAY_ENV || 'staging'}`);
  });
}

module.exports = app;
