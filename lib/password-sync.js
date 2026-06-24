const { proxyJson, isNetworkError } = require('./meshcentral-client');
const deviceBinding = require('./device-binding');

let inFlight = null;

/**
 * Push a pending local password change to Atomic Center. Safe to call often:
 * it no-ops when there is nothing queued and de-duplicates concurrent runs.
 */
async function syncPending() {
  if (inFlight) return inFlight;

  const pending = deviceBinding.getPendingPasswordSync();
  if (!pending) return { ok: true, synced: false };

  inFlight = (async () => {
    try {
      const result = await proxyJson(
        '/api/atomoforge/password-force-set',
        'POST',
        {
          username: pending.username,
          newPassword: pending.newPassword,
        },
        {},
        8000
      );

      const data = result.data || {};

      if (result.status >= 200 && result.status < 300 && data.success) {
        deviceBinding.clearPendingPasswordSync();
        console.log('[PasswordSync] Atomic Center password updated for', pending.username);
        return { ok: true, synced: true };
      }

      // The endpoint isn't deployed on Atomic Center yet (a 404 HTML page, not a
      // JSON API error). This is fixed by deploying atomoforge-api.js, so KEEP
      // the change queued and retry — never drop it here.
      if (data.htmlResponse) {
        deviceBinding.markPendingPasswordSyncAttempt(data.error || `HTTP ${result.status}`);
        console.warn(
          '[PasswordSync] Atomic Center force-set endpoint not available yet — keeping change queued for retry.',
          'Deploy with scripts/deploy-atomic-center-api.sh.'
        );
        return { ok: false, synced: false, retry: true, error: data.error };
      }

      // Genuine, permanent JSON rejections that retrying cannot fix: bad password
      // requirements (400), account not allowed (403), or the user truly does not
      // exist on Atomic Center (404 with a JSON body). Drop so we don't loop.
      if ([400, 403, 404].includes(result.status)) {
        deviceBinding.clearPendingPasswordSync();
        console.warn(
          '[PasswordSync] Dropping unsyncable password change for',
          pending.username,
          '-',
          data.error || result.status
        );
        return { ok: false, synced: false, dropped: true, error: data.error };
      }

      // Everything else (401 invalid API key, 5xx, etc.) may be transient or a
      // server-side config issue — keep the change and retry; it self-heals once
      // the server/config is fixed.
      deviceBinding.markPendingPasswordSyncAttempt(data.error || `HTTP ${result.status}`);
      return { ok: false, synced: false, error: data.error };
    } catch (e) {
      // Thrown errors are network/timeout (offline) — keep the item and retry.
      deviceBinding.markPendingPasswordSyncAttempt(e.message);
      return { ok: false, synced: false, error: e.message, network: isNetworkError(e) };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function hasPending() {
  return deviceBinding.getPendingPasswordSync() != null;
}

function startBackgroundSync({ isOnline, intervalMs = 20000 }) {
  if (typeof isOnline !== 'function') throw new Error('password-sync: isOnline is required');

  setInterval(async () => {
    try {
      if (!hasPending()) return;
      const online = await isOnline();
      if (!online) return;
      await syncPending();
    } catch {
      // best-effort
    }
  }, intervalMs);
}

module.exports = {
  syncPending,
  hasPending,
  startBackgroundSync,
};
