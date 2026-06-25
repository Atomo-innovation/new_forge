const { isDemoMode } = require('./demo-mode');

const DEMO_DETECTION_SLUGS = new Set(['person', 'fire-smoke']);
const LOCKED_NAV_IDS = new Set(['face', 'safety', 'ai-models', 'settings']);

const SUBSCRIPTION_TITLE = 'Subscription required';
const SUBSCRIPTION_MESSAGE =
  'This feature is included with an active Atomo Forge subscription. Upgrade your plan to unlock Face, Safety, AI Models, Settings, and more.';

function isDemoLockedDetectionSlug(slug) {
  return isDemoMode() && !DEMO_DETECTION_SLUGS.has(String(slug || '').trim());
}

function isDemoLockedNavId(navId) {
  return isDemoMode() && LOCKED_NAV_IDS.has(String(navId || '').trim());
}

function navLabelForId(navId) {
  const labels = {
    face: 'Face Recognition',
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
  isDemoLockedDetectionSlug,
  isDemoLockedNavId,
  navLabelForId,
};
