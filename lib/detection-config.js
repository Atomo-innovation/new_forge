const TABS = {
  person: {
    slug: 'person',
    title: 'Person',
    pageTitle: 'Person Detection',
    aiModelId: 'yolov8-perimeter',
    modelName: 'YOLOv8 Perimeter',
    modelVersion: 'v8.2.1',
    description: 'Real-time person detection, counting, tracking, and zone-aware alerts across assigned cameras.',
    featureOptions: [
      { id: 'detectPeople', label: 'Detect people', description: 'Core person class detection on every frame', locked: true },
      { id: 'countPeople', label: 'Count people', description: 'Live headcount across assigned camera feeds' },
      { id: 'boundingBoxes', label: 'Show bounding boxes', description: 'Draw detection boxes on stream preview and snapshots' },
      { id: 'trackMovement', label: 'Track movement', description: 'Follow person paths across consecutive frames' },
      { id: 'peopleCountLogs', label: 'Generate people count logs', description: 'Write timestamped count entries to the activity log' },
      { id: 'personPresence', label: 'Detect person presence', description: 'Raise presence state when at least one person is visible' },
      { id: 'filterSmallObjects', label: 'Filter small objects', description: 'Ignore detections below the minimum object size' },
    ],
    alertOptions: [
      { id: 'person-detected', label: 'Person detected', defaultEnabled: true },
      { id: 'person-not-detected', label: 'Person not detected', defaultEnabled: false },
      { id: 'too-many-people', label: 'Too many people', defaultEnabled: false },
      { id: 'person-restricted-area', label: 'Person in restricted area', defaultEnabled: true },
    ],
  },
  'fire-smoke': {
    slug: 'fire-smoke',
    title: 'Fire & Smoke',
    pageTitle: 'Fire & Smoke Detection',
    aiModelId: 'fire-smoke',
    modelName: 'Fire & Smoke',
    modelVersion: 'v3.1.0',
    description: 'Early fire and smoke detection with thermal-friendly confidence tuning.',
    alertOptions: [
      { id: 'fire-smoke-alert', label: 'Fire / smoke alert' },
      { id: 'intrusion-perimeter', label: 'Perimeter intrusion' },
    ],
  },
  face: {
    slug: 'face',
    title: 'Face',
    pageTitle: 'Face Recognition',
    aiModelId: 'face-recog',
    modelName: 'Face Recognition',
    modelVersion: 'v2.4.3',
    description: 'Face detection and watchlist matching on selected camera streams.',
    alertOptions: [
      { id: 'face-watchlist', label: 'Face watchlist match' },
      { id: 'loitering', label: 'Loitering detection' },
    ],
  },
  safety: {
    slug: 'safety',
    title: 'Safety',
    pageTitle: 'Safety & PPE',
    aiModelId: 'ppe-detection',
    modelName: 'PPE Detection',
    modelVersion: 'v1.8.2',
    description: 'PPE and safety compliance monitoring for industrial zones.',
    alertOptions: [
      { id: 'ppe-missing', label: 'PPE violation' },
      { id: 'intrusion-perimeter', label: 'Perimeter intrusion' },
    ],
  },
};

function getTab(slug) {
  return TABS[slug] || null;
}

function listSlugs() {
  return Object.keys(TABS);
}

module.exports = {
  TABS,
  getTab,
  listSlugs,
};
