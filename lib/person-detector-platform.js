/**
 * Person detector platform — Khadas NPU (person.py) vs x86 CPU dev fallback.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', 'Backend_Atomo_fordge');
const NPU_LIB = path.join(BACKEND_ROOT, 'lib', 'libnn_yolo26s.so');
const NPU_MODEL = path.join(BACKEND_ROOT, 'models', 'yolo26s.nb');

function isArmArch() {
  return process.arch === 'arm64' || process.arch === 'arm';
}

function npuAssetsPresent() {
  try {
    return fs.existsSync(NPU_LIB) && fs.existsSync(NPU_MODEL);
  } catch {
    return false;
  }
}

/** Production Khadas path — NPU only when model + library files exist on device. */
function isNpuPersonPlatform() {
  if (process.env.FORCE_CPU_PERSON === '1') return false;
  if (process.env.FORCE_NPU_PERSON === '1') return npuAssetsPresent();
  return npuAssetsPresent();
}

/** Dashboard local CPU worker — dev only, never on Khadas / NPU. */
function shouldUseLocalPersonWorker() {
  if (process.env.FORCE_LOCAL_PERSON === '1') return true;
  if (isNpuPersonPlatform()) return false;
  if (process.env.FORCE_BACKEND_PERSON === '1') return false;
  return false;
}

function workerBootMs() {
  return isNpuPersonPlatform() ? 6000 : 2500;
}

module.exports = {
  isNpuPersonPlatform,
  shouldUseLocalPersonWorker,
  npuAssetsPresent,
  workerBootMs,
  NPU_LIB,
  NPU_MODEL,
};
