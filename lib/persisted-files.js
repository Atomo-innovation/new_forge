const path = require('path');
const { getWritableDataDir } = require('./runtime-env');

const FILE_NAMES = [
  'device-binding.sqlite',
  'master-control.sqlite',
  'device.json',
  'active-session.json',
  'cameras.json',
  'detection-models.json',
  'pending-flows.json',
];

const BLOB_PREFIX = 'atomo-forge/';

function localPaths() {
  const dir = getWritableDataDir();
  return FILE_NAMES.map((name) => path.join(dir, name));
}

function blobPath(name) {
  return `${BLOB_PREFIX}${name}`;
}

module.exports = {
  FILE_NAMES,
  BLOB_PREFIX,
  localPaths,
  blobPath,
};
