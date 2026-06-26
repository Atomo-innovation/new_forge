const HASH_NAV = {
  '#/person': 'person',
  '#/fire-smoke': 'fire-smoke',
  '#/face': 'face',
  '#/safety': 'safety',
  '#/ai-models': 'ai-models',
  '#/settings': 'settings',
};

function sessionUrl(path) {
  return path;
}

function setActiveNav() {
  const { pathname, hash } = window.location;
  let activeId = null;

  if (pathname === '/overview') {
    activeId = 'overview';
  } else if (pathname.startsWith('/cameras/')) {
    activeId = 'overview';
  } else if (pathname.startsWith('/detection/')) {
    activeId = pathname.split('/')[2] || null;
  } else if (pathname === '/settings') {
    activeId = 'settings';
  } else if (pathname === '/dashboard' && hash) {
    activeId = HASH_NAV[hash] || HASH_NAV[hash.replace(/\/$/, '')] || null;
  }

  document.querySelectorAll('.ov-nav a[data-nav-id]').forEach((link) => {
    link.classList.toggle('active', link.dataset.navId === activeId);
  });
}

function updateSidebarUser(name) {
  const display = String(name || 'User').trim() || 'User';
  const userName = document.getElementById('userName');
  const userAvatar = document.getElementById('userAvatar');
  if (userName) userName.textContent = display;
  if (userAvatar) userAvatar.textContent = display.charAt(0).toUpperCase();
}

function readCachedUsername() {
  try {
    return sessionStorage.getItem('atomoUsername') || '';
  } catch {
    return '';
  }
}

async function loadSidebarUser() {
  const cached = readCachedUsername();
  if (cached) updateSidebarUser(cached);

  try {
    const url = window.AFSession ? window.AFSession.sessionUrl('/api/session') : sessionUrl('/api/session');
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.authenticated) return;

    if (data.sessionId) {
      sessionStorage.setItem('atomoSessionId', data.sessionId);
    }
    if (data.username) {
      sessionStorage.setItem('atomoUsername', data.username);
    }

    updateSidebarUser(data.username);
  } catch {
    /* ignore */
  }
}

const THEME_STORAGE_KEY = 'atomo-overview-theme';

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  updateThemeToggleButton(next);
}

function updateThemeToggleButton(theme) {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = theme === 'dark';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = isDark
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
  applyTheme(saved);

  const btn = document.getElementById('themeToggle');
  if (!btn || btn.dataset.themeBound === 'true') return;
  btn.dataset.themeBound = 'true';

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

async function initLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn || btn.dataset.logoutBound === 'true') return;
  btn.dataset.logoutBound = 'true';

  btn.addEventListener('click', async () => {
    const sid = sessionStorage.getItem('atomoSessionId');
    if (sid) {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
    }
    sessionStorage.removeItem('atomoSessionId');
    sessionStorage.removeItem('atomoUsername');
    window.location.href = '/login';
  });
}

function initMobileNav() {
  const toggle = document.getElementById('navToggle');
  if (!toggle) return;

  const setOpen = (open) => {
    document.body.classList.toggle('ov-nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const label = open ? 'Close menu' : 'Open menu';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!document.body.classList.contains('ov-nav-open'));
  });

  document.querySelectorAll('.ov-nav a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('ov-nav-open')) return;
    if (e.target.closest('.ov-sidebar') || e.target.closest('#navToggle')) return;
    setOpen(false);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1200) setOpen(false);
  });
}

const SUBSCRIPTION_TITLE = 'Subscription required';
const SUBSCRIPTION_MESSAGE =
  'This feature is included with an active Atomo Forge subscription. Upgrade your plan to unlock Fire & Smoke, Safety, AI Models, Settings, and more.';

const NAV_LABELS = {
  'fire-smoke': 'Fire & Smoke',
  safety: 'Safety & PPE',
  'ai-models': 'AI Models',
  settings: 'Settings',
};

function ensureSubscriptionModal() {
  if (document.getElementById('subscriptionModal')) return;

  const wrap = document.createElement('div');
  wrap.id = 'subscriptionModal';
  wrap.className = 'ov-modal';
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="ov-modal-backdrop" data-action="close-subscription"></div>
    <div class="ov-modal-dialog ov-subscription-dialog" role="dialog" aria-modal="true" aria-labelledby="subscriptionModalTitle">
      <div class="ov-modal-head">
        <h2 class="ov-modal-title" id="subscriptionModalTitle">${SUBSCRIPTION_TITLE}</h2>
        <button type="button" class="ov-modal-close" data-action="close-subscription" aria-label="Close">&times;</button>
      </div>
      <div class="ov-modal-body">
        <p id="subscriptionModalMessage">${SUBSCRIPTION_MESSAGE}</p>
      </div>
      <div class="ov-modal-foot">
        <a href="/detection/person" class="ov-quick-btn">Try Person detection</a>
        <a href="/detection/face" class="ov-quick-btn">Try Face recognition</a>
        <button type="button" class="ov-cam-add-btn" data-action="close-subscription">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  wrap.querySelectorAll('[data-action="close-subscription"]').forEach((el) => {
    el.addEventListener('click', closeSubscriptionModal);
  });
}

function showSubscriptionModal(featureLabel) {
  ensureSubscriptionModal();
  const modal = document.getElementById('subscriptionModal');
  const msg = document.getElementById('subscriptionModalMessage');
  if (msg) {
    msg.textContent = featureLabel
      ? `${featureLabel} is included with an active Atomo Forge subscription. Upgrade your plan to unlock Fire & Smoke, Safety, AI Models, Settings, and more.`
      : SUBSCRIPTION_MESSAGE;
  }
  modal.hidden = false;
  document.body.classList.add('ov-modal-open');
}

function closeSubscriptionModal() {
  const modal = document.getElementById('subscriptionModal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('ov-modal-open');
}

async function initSubscriptionGate() {
  let demoMode = false;
  try {
    const url = window.AFSession ? window.AFSession.sessionUrl('/api/session') : sessionUrl('/api/session');
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    demoMode = data.demoMode === true;
  } catch {
    /* ignore */
  }

  document.body.classList.toggle('demo-mode', demoMode);

  if (!demoMode) return;

  document.querySelectorAll('.ov-nav a[data-subscription-lock="true"]').forEach((link) => {
    if (link.dataset.subscriptionBound === 'true') return;
    link.dataset.subscriptionBound = 'true';
    link.addEventListener('click', (e) => {
      if (link.dataset.navId === 'settings') return;
      e.preventDefault();
      showSubscriptionModal(NAV_LABELS[link.dataset.navId] || 'This feature');
    });
  });
}

function initAppShell() {
  setActiveNav();
  loadSidebarUser();
  initTheme();
  initLogout();
  initMobileNav();
  initSubscriptionGate();
  if (window.LiveMetrics && document.getElementById('liveMetricsStrip')) {
    window.LiveMetrics.init();
  }
  window.addEventListener('hashchange', setActiveNav);
}

window.showSubscriptionModal = showSubscriptionModal;

window.updateSidebarUser = updateSidebarUser;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAppShell);
} else {
  initAppShell();
}
