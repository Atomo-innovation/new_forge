/**
 * Overview dashboard data — served via GET /api/overview
 * TODO: replace mock sections with live device metrics
 */

const deviceProfile = require('./device-profile');

const overview = {
  cameras: {
    total: 24,
    active: 21,
    offline: 3,
    uptimePercent: 87.5,
    offlineLastSeen: '2h ago',
  },
  aiModels: [
    { id: 'yolov8-perimeter', name: 'YOLOv8 Perimeter Detection', shortLabel: 'Perimeter', running: true },
    { id: 'reid-tracking', name: 'Re-ID Person Tracking', shortLabel: 'Person Track', running: true },
    { id: 'lpr-anpr', name: 'LPR / ANPR Engine', shortLabel: 'LPR / ANPR', running: true },
    { id: 'crowd-density', name: 'Crowd Density Estimator', shortLabel: 'Crowd', running: false },
    { id: 'ppe-detection', name: 'PPE Compliance Checker', shortLabel: 'PPE', running: false },
  ],
  alerts: {
    todayTotal: 17,
    criticalOpen: 2,
    lastAlertAt: '2026-06-13T06:12:44Z',
  },
  alertBreakdown: { critical: 2, high: 5, medium: 10, low: 0, info: 0 },
  resources: {
    cpuPercent: 34,
    npuPercent: 67,
    ramUsedGb: 5.8,
    ramTotalGb: 16,
    storageUsedGb: 187,
    storageTotalGb: 512,
    cpuHistory: [28, 32, 35, 38, 36, 40, 44, 41, 39, 43, 34],
    ramHistory: [32, 34, 35, 36, 35, 37, 36, 38, 37, 36, 36],
    npuHistory: [52, 58, 61, 64, 66, 68, 65, 67, 69, 67, 67],
  },
  network: {
    interfaceName: 'eth0',
    downloadMbps: 124.6,
    uploadMbps: 38.2,
    deviceIp: '192.168.10.42',
    downloadHistory: [72, 88, 95, 102, 110, 115, 118, 122, 120, 124.6],
    uploadHistory: [18, 22, 26, 24, 30, 32, 35, 34, 36, 38.2],
  },
  health: {
    temperatureC: 58,
    uptimeBaseSecs: 2847123,
    powerSource: 'ac',
  },
  sync: {
    status: 'connected',
    atomicCentreUrl: 'https://atomic-centre.atomo.io',
  },
  deviceRole: {
    role: 'Edge AI Gateway',
    clusterMode: 'master',
  },
  license: {
    edition: 'Enterprise',
    daysRemaining: 275,
    status: 'valid',
  },
  statistic: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    cameraEvents: [42, 58, 51, 67, 72, 48, 61],
    alertEvents: [12, 18, 14, 22, 17, 11, 19],
    totalEvents: 375,
  },
  alertTrend: {
    today: [4, 6, 3, 8, 5, 9, 7, 11, 6, 8, 17],
    week: [42, 38, 51, 47, 55, 49, 61],
    month: [120, 145, 132, 168, 155, 172, 189, 201, 178, 195, 210, 198],
  },
  cameraFeeds: [
    { id: 'cam-1', name: 'North Gate', status: 'online' },
    { id: 'cam-2', name: 'Loading Dock', status: 'online' },
  ],
};

function getOverviewPayload(sess) {
  const profile = deviceProfile.getProfile();
  const clusterMode = deviceProfile.getClusterMode() || overview.deviceRole.clusterMode;

  return {
    username: sess?.username || 'operator',
    userRole: sess?.userRole || null,
    ...overview,
    device: {
      hostname: profile?.deviceName || 'atomo-gw-floor3',
      deviceId: profile?.deviceSerial || 'af-edge-7c3f-a912',
      firmwareVersion: 'v2.4.1-build891',
      osVersion: 'Atomo Edge OS 1.8.0',
      organizationName: profile?.organizationName || 'Atomo Industries',
    },
    deviceRole: {
      ...overview.deviceRole,
      clusterMode,
    },
    sync: {
      ...overview.sync,
      atomicCentreHost: overview.sync.atomicCentreUrl.replace(/^https?:\/\//, ''),
    },
    resources: {
      ...overview.resources,
      ramPercent: Math.round((overview.resources.ramUsedGb / overview.resources.ramTotalGb) * 100),
      storagePercent: Math.round(
        (overview.resources.storageUsedGb / overview.resources.storageTotalGb) * 100
      ),
    },
    aiModelsRunning: overview.aiModels.filter((m) => m.running).length,
    aiModelsTotal: overview.aiModels.length,
  };
}

module.exports = { getOverviewPayload, overview };
