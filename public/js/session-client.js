(function () {
  const DASHBOARD_PATHS = new Set([
    '/overview',
    '/dashboard',
    '/cluster-role',
    '/user-role',
    '/device-registration',
  ]);

  function isDashboardPath(pathname) {
    if (DASHBOARD_PATHS.has(pathname)) return true;
    return pathname.startsWith('/cameras/') || pathname.startsWith('/detection/');
  }

  function sessionUrl(path) {
    return path;
  }

  async function fetchSession() {
    const res = await fetch(sessionUrl('/api/session'), { credentials: 'same-origin' });
    return res.json();
  }

  async function requireAuth(options) {
    const opts = options || {};
    const allowPaths = opts.allowPaths || [];
    const pathname = window.location.pathname;

    try {
      const data = await fetchSession();
      if (!data.authenticated) {
        window.location.href = '/login';
        return null;
      }

      if (data.sessionId) {
        sessionStorage.setItem('atomoSessionId', data.sessionId);
      }

      const allowedHere = allowPaths.includes(pathname)
        || (pathname === '/device-registration' && (data.demoMode || data.redirectTo === '/device-registration'))
        || (pathname === '/overview' && (data.redirectTo === '/overview' || data.redirectTo === '/dashboard'))
        || (pathname === '/dashboard' && data.redirectTo === '/overview');

      if (data.redirectTo && data.redirectTo !== pathname && !allowedHere && isDashboardPath(pathname)) {
        if (data.redirectTo !== '/overview' || pathname !== '/dashboard') {
          window.location.href = data.redirectTo;
          return null;
        }
      }

      return data;
    } catch {
      window.location.href = '/login';
      return null;
    }
  }

  window.AFSession = {
    sessionUrl,
    fetchSession,
    requireAuth,
  };
})();
