const deviceProfile = require('./device-profile');
const session = require('./session');
const dashboardAuth = require('./dashboard-auth');
const dashboardRbac = require('./dashboard-rbac');

function buildDemoRegistrationPhases(profilePayload) {
  const groupName =
    profilePayload.meshGroupName
    || `${profilePayload.organizationName || 'Demo'} Devices`;

  return [
    {
      id: 'connect',
      label: 'Connecting to Atomic Center…',
      status: 'done',
      message: 'Connected to Atomic Center (AWS).',
    },
    {
      id: 'group',
      label: 'Creating device group on Atomic Center…',
      status: 'done',
      message: `Device group "${groupName}" is ready.`,
    },
    {
      id: 'cloud',
      label: 'Saving device profile…',
      status: 'done',
      message: `Profile saved for ${profilePayload.deviceName || 'your device'}.`,
    },
    {
      id: 'dashboard',
      label: 'Preparing dashboard…',
      status: 'done',
      message: 'Demo environment ready — opening dashboard.',
    },
  ];
}

function completeDemoSession(sessRecord, profilePayload) {
  deviceProfile.setClusterMode('standalone');
  session.confirmClusterRole(sessRecord.sessionId);
  dashboardAuth.markClusterRole(sessRecord, 'standalone');

  const roleId = dashboardRbac.getDefaultRoleIdForClusterMode('standalone');
  const role = dashboardRbac.setUserRole(sessRecord.meshUserId, roleId);
  session.confirmUserRole(sessRecord.sessionId, role.id);
  dashboardAuth.markUserRole(sessRecord, role.id);

  return session.getSessionRecord(sessRecord.sessionId);
}

function buildDemoRegistrationResult({ sessRecord, profile, profilePayload }) {
  const groupName =
    profilePayload.meshGroupName
    || `${profilePayload.organizationName || 'Demo'} Devices`;
  const phases = buildDemoRegistrationPhases(profilePayload);
  const updated = completeDemoSession(sessRecord, profilePayload);

  return {
    success: true,
    demoMode: true,
    cloudPortal: true,
    message: 'Device registered successfully. Opening your dashboard…',
    profile,
    phases,
    meshCentral: {
      demo: true,
      meshGroupName: groupName,
      meshGroupCreated: true,
      profileStoredOnCloud: true,
      meshCentralUrl: process.env.MESHCENTRAL_URL || null,
    },
    onboardingComplete: true,
    redirectTo: '/overview',
    sessionId: updated?.sessionId || sessRecord.sessionId,
    profileStoredOnCloud: true,
    partial: false,
  };
}

module.exports = {
  buildDemoRegistrationPhases,
  completeDemoSession,
  buildDemoRegistrationResult,
};
