const fs = require('fs');
const path = require('path');
const { getWritableDataDir, isServerlessRuntime } = require('./runtime-env');

function resolveStoragePath(envOverride, configRelativePath, defaultFilename) {
  if (envOverride) {
    return path.resolve(envOverride);
  }
  // app-config.json defaults to data/* which is read-only on Vercel — always use /tmp there.
  if (isServerlessRuntime()) {
    return path.join(getWritableDataDir(), defaultFilename);
  }
  if (configRelativePath) {
    return path.resolve(path.join(__dirname, '..', configRelativePath));
  }
  return path.join(getWritableDataDir(), defaultFilename);
}

const CONFIG_PATH = path.join(__dirname, '..', 'app-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getMeshcentralUrl() {
  if (process.env.MESHCENTRAL_URL) {
    return String(process.env.MESHCENTRAL_URL).replace(/\/$/, '');
  }
  const cfg = loadConfig();
  const url = cfg.meshcentralUrl || cfg.atomicCenterApiUrl;
  if (url) {
    return String(url).replace(/\/$/, '');
  }
  return null;
}

function isRemoteMode() {
  return Boolean(getMeshcentralUrl());
}

function allowInsecureTls() {
  if (process.env.MESHCENTRAL_INSECURE_TLS === '1') return true;
  const cfg = loadConfig();
  return cfg.allowInsecureTls === true;
}

function offlineLoginEnabled() {
  if (process.env.OFFLINE_LOGIN === '0') return false;
  if (process.env.OFFLINE_LOGIN === '1') return true;
  const cfg = loadConfig();
  return cfg.offlineLogin !== false;
}

function getDeviceBindingDbPath() {
  const cfg = loadConfig();
  return resolveStoragePath(
    process.env.DEVICE_BINDING_DB,
    cfg.deviceBindingDb,
    'device-binding.sqlite'
  );
}

function getDeviceIdPath() {
  const cfg = loadConfig();
  return resolveStoragePath(
    process.env.DEVICE_ID_FILE,
    cfg.deviceIdFile,
    'device.json'
  );
}

function singleUserPerDevice() {
  if (process.env.SINGLE_USER_PER_DEVICE === '0') return false;
  const cfg = loadConfig();
  return cfg.singleUserPerDevice !== false;
}

function singleSessionEnabled() {
  if (process.env.SINGLE_SESSION === '0') return false;
  const cfg = loadConfig();
  return cfg.singleSession !== false;
}

function getSessionTtlMs() {
  const cfg = loadConfig();
  const hours = cfg.sessionTtlHours || 24;
  return hours * 60 * 60 * 1000;
}

function getAtomoforgeApiKey() {
  if (process.env.ATOMOFORGE_API_KEY) {
    return String(process.env.ATOMOFORGE_API_KEY);
  }
  const cfg = loadConfig();
  return cfg.atomoforgeApiKey || null;
}

module.exports = {
  loadConfig,
  getWritableDataDir,
  isServerlessRuntime,
  getMeshcentralUrl,
  isRemoteMode,
  allowInsecureTls,
  offlineLoginEnabled,
  getDeviceBindingDbPath,
  getDeviceIdPath,
  singleUserPerDevice,
  singleSessionEnabled,
  getSessionTtlMs,
  getAtomoforgeApiKey,
  CONFIG_PATH,
};
