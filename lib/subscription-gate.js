const { isDemoMode } = require('./demo-mode');

const DEMO_DETECTION_SLUGS = new Set(['person', 'face']);
const LOCKED_NAV_IDS = new Set(['fire-smoke', 'safety', 'ai-models', 'settings']);

const SUBSCRIPTION_TITLE = 'Subscription required';
const SUBSCRIPTION_MESSAGE =
  'This feature is included with an active Atomo Forge subscription. Upgrade your plan to unlock Fire & Smoke, Safety, AI Models, Settings, and more.';

function isDemoLockedDetectionSlug(slug) {
  return isDemoMode() && !DEMO_DETECTION_SLUGS.has(String(slug || '').trim());
}

const SETTINGS_DISABLED_TITLE = 'Settings unavailable';
const SETTINGS_DISABLED_MESSAGE =
  'Device, network, storage, and system settings are disabled in this environment. An active Atomo Forge subscription is required to configure your deployment.';

function isDemoLockedNavId(navId) {
  return isDemoMode() && LOCKED_NAV_IDS.has(String(navId || '').trim());
}

function navLabelForId(navId) {
  const labels = {
    'fire-smoke': 'Fire & Smoke',
    safety: 'Safety & PPE',
    'ai-models': 'AI Models',
    settings: 'Settings',
  };
  return labels[navId] || 'This feature';
}

module.exports = {
  DEMO_DETECTION_SLUGS,
  LOCKED_NAV_IDS,
  SUBSCRIPTION_TITLE,
  SUBSCRIPTION_MESSAGE,
  SETTINGS_DISABLED_TITLE,
  SETTINGS_DISABLED_MESSAGE,
  isDemoLockedDetectionSlug,
  isDemoLockedNavId,
  navLabelForId,
};
