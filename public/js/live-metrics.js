(function () {
  const POLL_MS = 2000;
  const STALE_MS = 8000;
  const EMA = 0.4;
  const API_BASE = window.__ATOMO_API_URL__ || '';

  const ICONS = {
    cpu: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
    brain: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
    temp: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
    net: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 7 10 10M17 7v10H7"/></svg>',
    ram: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M6 7h12v4H6z"/></svg>',
    disk: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
  };

  let display = null;
  let meta = { live: false, board: '', fetchedAt: 0, offline: false };
  let pollTimer = null;

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    const base = `${API_BASE}${path}`;
    if (!sid) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}sessionId=${encodeURIComponent(sid)}`;
  }

  function navPctClass(pct) {
    if (pct > 80) return 'accent';
    if (pct > 60) return 'warn';
    return '';
  }

  function tempClass(temp) {
    if (temp > 75) return 'hot';
    if (temp > 60) return 'warn';
    return '';
  }

  function ema(prev, next) {
    if (prev === null || prev === undefined) return next;
    if (next === null || next === undefined) return prev;
    return prev * (1 - EMA) + next * EMA;
  }

  function formatBytesGb(bytes) {
    if (!bytes || bytes <= 0) return null;
    return (bytes / (1024 ** 3)).toFixed(1);
  }

  function mapStats(data) {
    if (!data) {
      meta.offline = true;
      meta.live = false;
      return display;
    }

    if (data._demo) {
      const prev = display || {};
      meta.offline = false;
      meta.live = true;
      meta.board = 'Demo edge';
      meta.fetchedAt = Date.now();
      const cpu = Math.round(ema(prev.cpu, data.cpu ?? 0));
      const ramPct = Math.round(ema(prev.ramPct, data.ram ?? 0));
      const storagePct = Math.round(ema(prev.storagePct, data.storage ?? 0));
      const temp = data.temp != null ? Math.round(ema(prev.temp, data.temp)) : prev.temp;
      const npu = data.npu != null ? Math.round(ema(prev.npu, data.npu)) : prev.npu;
      const download = data.net != null ? ema(prev.download, data.net) : prev.download;
      return {
        cpu,
        npu,
        ramPct,
        storagePct,
        storageUsed: prev.storageUsed ?? 0,
        storageTotal: prev.storageTotal ?? 0,
        temp,
        download,
        npuLabel: 'demo',
        tempSource: 'demo',
        workers: data.workers?.count || 0,
      };
    }

    if (data._boardOffline || data._fallback) {
      meta.offline = true;
      meta.live = false;
      return display;
    }

    const prev = display || {};
    meta.offline = false;
    meta.live = data.live !== false;
    meta.board = data.board_hostname || data.board || '';
    meta.fetchedAt = Date.now();
    meta.ageMs = data.age_ms ?? 0;
    meta.npuSource = data.npu_detail?.source || null;

    const cpu = Math.round(ema(prev.cpu, data.cpu ?? data.cpu_detail?.load_pct ?? 0));
    const ramPct = Math.round(ema(prev.ramPct, data.ram ?? data.ram_detail?.used_pct ?? 0));
    const storagePct = data.storage ?? data.storage_detail?.used_pct ?? prev.storagePct ?? 0;
    const storageUsed = data.storage_detail?.used ?? prev.storageUsed ?? 0;
    const storageTotal = data.storage_detail?.total ?? prev.storageTotal ?? 0;

    const tempRaw = data.temp ?? data.cpu_detail?.temp_c ?? data.temp_detail?.temp_c;
    const temp = tempRaw !== null && tempRaw !== undefined
      ? Math.round(ema(prev.temp, tempRaw))
      : prev.temp;

    const npuRaw = data.npu ?? data.npu_detail?.load_pct;
    const npu = npuRaw !== null && npuRaw !== undefined
      ? Math.round(ema(prev.npu, npuRaw))
      : prev.npu;

    const netRaw = data.net ?? data.net_detail?.download_mbps;
    const download = netRaw !== null && netRaw !== undefined
      ? ema(prev.download, netRaw)
      : prev.download;

    return {
      cpu, npu, ramPct, storagePct, storageUsed, storageTotal, temp, download,
      npuLabel: data.npu_detail?.label || meta.npuSource,
      tempSource: data.temp_detail?.source,
      workers: data.workers?.count || 0,
    };
  }

  async function fetchLiveStats() {
    try {
      const res = await fetch(sessionUrl('/api/system/stats'));
      if (!res.ok) {
        meta.offline = true;
        meta.live = false;
        return display;
      }
      const data = await res.json();
      display = mapStats(data);
      return display;
    } catch {
      meta.offline = true;
      meta.live = false;
      return display;
    }
  }

  function formatNpu(d) {
    if (meta.offline) return '—';
    if (d.npu !== null && d.npu !== undefined) {
      const suffix = d.npuLabel === 'duty-cycle' ? '~' : '';
      return `${Math.round(d.npu)}%${suffix}`;
    }
    return '—';
  }

  function formatNet(d) {
    if (meta.offline || d.download === null || d.download === undefined) return '—';
    return `${Number(d.download).toFixed(1)} Mbps`;
  }

  function npuTitle(d) {
    if (d.npuLabel === 'hardware') return 'NPU hardware load (sysfs)';
    if (d.npuLabel === 'duty-cycle') {
      return `NPU duty cycle from inference (${d.workers} worker(s)). ~ = estimated, not silicon counter.`;
    }
    if (d.npu != null) return 'NPU utilization';
    return 'NPU not available — start detection on board';
  }

  function renderMetricItem(m) {
    return `
    <div class="ov-metric-item" title="${m.title || ''}">
      ${m.icon}
      <span class="ov-metric-label">${m.label}</span>
      <span class="ov-metric-value ${m.cls}">${m.value}</span>
    </div>`;
  }

  function renderStorageItem(d) {
    const pct = Math.max(0, Math.min(100, Math.round(d.storagePct)));
    const cls = navPctClass(pct);
    const usedGb = formatBytesGb(d.storageUsed);
    const totalGb = formatBytesGb(d.storageTotal);
    const hasDetail = usedGb && totalGb && d.storageTotal > 0;
    const title = hasDetail
      ? `Disk: ${usedGb} GB used of ${totalGb} GB (${pct}%) — board root filesystem`
      : 'Disk usage on board';
    const valueText = meta.offline ? '—' : (hasDetail ? `${pct}%` : (pct > 0 ? `${pct}%` : '—'));

    return `
    <div class="ov-metric-item ov-metric-item--storage" title="${title}">
      ${ICONS.disk}
      <span class="ov-metric-label">Disk</span>
      <span class="ov-metric-bar-inline" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Storage used">
        <span class="ov-metric-bar-fill ${cls}" style="width:${hasDetail && !meta.offline ? pct : 0}%"></span>
      </span>
      <span class="ov-metric-value ${cls}">${valueText}</span>
    </div>`;
  }

  function render(d) {
    const strip = document.getElementById('liveMetricsStrip');
    if (!strip) return;

    const stale = meta.fetchedAt && Date.now() - meta.fetchedAt > STALE_MS;
    const offline = meta.offline || stale;
    strip.classList.toggle('ov-metrics-strip--offline', offline);
    strip.classList.toggle('ov-metrics-strip--live', !offline && meta.live);

    if (!d && offline) {
      strip.innerHTML = '<div class="ov-metric-item ov-metric-item--offline">Board offline</div>';
      return;
    }
    if (!d) return;

    const boardHint = meta.board ? ` · ${meta.board}` : '';
    const items = [
      {
        icon: ICONS.cpu,
        label: 'CPU',
        value: offline ? '—' : `${d.cpu}%`,
        cls: offline ? 'muted' : navPctClass(d.cpu),
        title: `CPU load on vision board${boardHint}`,
      },
      {
        icon: ICONS.brain,
        label: 'NPU',
        value: formatNpu(d),
        cls: offline ? 'muted' : (d.npu != null ? navPctClass(d.npu) : ''),
        title: npuTitle(d),
      },
      {
        icon: ICONS.ram,
        label: 'RAM',
        value: offline ? '—' : `${d.ramPct}%`,
        cls: offline ? 'muted' : navPctClass(d.ramPct),
        title: `RAM pressure on board (unavailable memory)${boardHint}`,
      },
      null,
      {
        icon: ICONS.temp,
        label: 'Temp',
        value: offline || d.temp == null ? '—' : `${d.temp}°C`,
        cls: offline ? 'muted' : tempClass(d.temp),
        title: d.tempSource === 'thermal'
          ? `SoC max thermal zone${boardHint}`
          : `Board temperature${boardHint}`,
      },
      {
        icon: ICONS.net,
        label: 'Net ↓',
        value: formatNet(d),
        cls: offline ? 'muted' : '',
        title: 'Download throughput on primary network interface',
      },
    ];

    strip.innerHTML = items
      .map((m, i) => (i === 3 ? renderStorageItem(d) : renderMetricItem(m)))
      .join('');
  }

  async function poll() {
    if (document.hidden) return;
    const d = await fetchLiveStats();
    render(d);
  }

  async function init() {
    const strip = document.getElementById('liveMetricsStrip');
    if (!strip) return;

    await poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  window.LiveMetrics = { init, render, stop, fetchLiveStats, POLL_MS };
})();
