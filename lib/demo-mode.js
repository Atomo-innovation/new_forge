const { isServerlessRuntime } = require('./runtime-env');

function isDemoMode() {
  if (process.env.DEMO_MODE === '0') return false;
  if (process.env.DEMO_MODE === '1') return true;
  return isServerlessRuntime();
}

module.exports = {
  isDemoMode,
};
