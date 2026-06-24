const path = require('path');
const { loadConfig, getWritableDataDir } = require('../device-config');
const { isServerlessRuntime } = require('../runtime-env');

function getMasterControlDbPath() {
  if (process.env.MASTER_CONTROL_DB) {
    return path.resolve(process.env.MASTER_CONTROL_DB);
  }
  if (isServerlessRuntime()) {
    return path.join(getWritableDataDir(), 'master-control.sqlite');
  }
  const cfg = loadConfig();
  if (cfg.masterControlDb) {
    return path.resolve(path.join(__dirname, '..', '..', cfg.masterControlDb));
  }
  return path.join(getWritableDataDir(), 'master-control.sqlite');
}

function getMasterControlEnvironment() {
  return process.env.MASTER_CONTROL_ENV || loadConfig().masterControlEnv || 'production';
}

module.exports = {
  getMasterControlDbPath,
  getMasterControlEnvironment,
};
