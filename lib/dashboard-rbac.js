const fs = require('fs');
const path = require('path');
const { openSqliteDatabase } = require('./sqlite-open');
const { getDeviceBindingDbPath } = require('./device-config');

const ROLES = [
  {
    id: 'owner',
    name: 'Owner',
    description:
      'Full control over device, users, licenses, models, cloud sync, billing, and factory reset.',
    permissions: ['*'],
  },
  {
    id: 'admin',
    name: 'Admin',
    description:
      'Can add cameras, configure AI models, manage alerts, view reports, and manage operators.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'cameras.read',
      'cameras.write',
      'models.read',
      'models.write',
      'alerts.manage',
      'reports.read',
      'users.manage',
      'settings.read',
    ],
  },
  {
    id: 'operator',
    name: 'Operator',
    description:
      'Can monitor dashboard, view camera feeds, acknowledge alerts, and export limited reports.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'cameras.read',
      'live.view',
      'alerts.ack',
      'reports.limited',
    ],
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description: 'Can only view dashboard and camera status.',
    permissions: ['dashboard.read', 'cameras.read'],
  },
  {
    id: 'maintenance_engineer',
    name: 'Maintenance Engineer',
    description:
      'Can access logs, device health, OTA, diagnostics, and system-level configuration.',
    permissions: [
      'dashboard.read',
      'health.read',
      'logs.read',
      'ota.manage',
      'diagnostics',
      'system.config',
      'settings.read',
      'settings.write',
    ],
  },
  {
    id: 'developer',
    name: 'Developer',
    description:
      'Can upload custom AI models, configure inference pipeline, test model output, and manage APIs.',
    permissions: [
      'dashboard.read',
      'models.read',
      'models.write',
      'models.test',
      'pipeline.config',
      'api.manage',
      'cameras.read',
    ],
  },
];

const ROUTE_PERMISSIONS = {
  '/overview': 'dashboard.read',
  '/person': 'detection.view',
  '/fire-smoke': 'detection.view',
  '/face': 'detection.view',
  '/safety': 'detection.view',
  '/cameras': 'cameras.read',
  '/cameras/add': 'cameras.write',
  '/live-view': 'live.view',
  '/ai-models': 'models.read',
  '/health-check': 'health.read',
  '/settings': 'settings.read',
  '/master': 'platform.read',
  '/master/platform': 'platform.write',
  '/master/flags': 'platform.read',
  '/master/config': 'platform.write',
  '/master/audit': 'audit.read',
  '/master/security': 'security.read',
  '/master/monitoring': 'monitoring.read',
};

let db;

function getDb() {
  if (db) return db;
  db = openSqliteDatabase(getDeviceBindingDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_dashboard_roles (
      mesh_user_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL
    );
  `);
  return db;
}

const MASTER_ROLE_IDS = ['admin', 'viewer'];
const STANDALONE_DEFAULT_ROLE_ID = 'admin';

function normalizeClusterMode(clusterMode) {
  return String(clusterMode || '').trim().toLowerCase();
}

function listRolesForClusterMode(clusterMode) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'master') {
    return ROLES.filter((role) => MASTER_ROLE_IDS.includes(role.id));
  }
  if (mode === 'slave') {
    return ROLES;
  }
  return [];
}

function isRoleAllowedForClusterMode(clusterMode, roleId) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'standalone') return false;
  return listRolesForClusterMode(mode).some((role) => role.id === roleId);
}

function getDefaultRoleIdForClusterMode(clusterMode) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'standalone') return STANDALONE_DEFAULT_ROLE_ID;
  if (mode === 'master') return 'admin';
  return 'operator';
}

function listRoles() {
  return ROLES;
}

function getRole(roleId) {
  return ROLES.find((r) => r.id === roleId) || null;
}

function getUserRole(meshUserId) {
  const row = getDb()
    .prepare('SELECT role_id FROM user_dashboard_roles WHERE mesh_user_id = ?')
    .get(String(meshUserId || '').trim());
  return row ? getRole(row.role_id) : null;
}

function setUserRole(meshUserId, roleId) {
  const role = getRole(roleId);
  if (!role) {
    const err = new Error('Invalid role. Choose a valid dashboard role.');
    err.status = 400;
    throw err;
  }
  getDb()
    .prepare(`
      INSERT INTO user_dashboard_roles (mesh_user_id, role_id, assigned_at)
      VALUES (?, ?, ?)
      ON CONFLICT(mesh_user_id) DO UPDATE SET
        role_id = excluded.role_id,
        assigned_at = excluded.assigned_at
    `)
    .run(String(meshUserId).trim(), role.id, Date.now());
  return role;
}

function hasPermission(roleId, permission) {
  const role = getRole(roleId);
  if (!role) return false;
  if (role.permissions.includes('*')) return true;
  if (role.permissions.includes(permission)) return true;
  const [ns] = permission.split('.');
  return role.permissions.includes(`${ns}.*`);
}

function canAccessRoute(roleId, route) {
  const perm = ROUTE_PERMISSIONS[route];
  if (!perm) return hasPermission(roleId, 'dashboard.read');
  return hasPermission(roleId, perm);
}

function getAllowedRoutes(roleId) {
  return Object.keys(ROUTE_PERMISSIONS).filter((route) => canAccessRoute(roleId, route));
}

function getRolePayload(roleId) {
  const role = getRole(roleId);
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    allowedRoutes: getAllowedRoutes(role.id),
  };
}

function resetDbConnection() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

module.exports = {
  ROLES,
  MASTER_ROLE_IDS,
  STANDALONE_DEFAULT_ROLE_ID,
  ROUTE_PERMISSIONS,
  listRoles,
  listRolesForClusterMode,
  isRoleAllowedForClusterMode,
  getDefaultRoleIdForClusterMode,
  normalizeClusterMode,
  getRole,
  getUserRole,
  setUserRole,
  hasPermission,
  canAccessRoute,
  getAllowedRoutes,
  getRolePayload,
  resetDbConnection,
};
