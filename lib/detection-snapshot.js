function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const SEVERITY_COLORS = {
  critical: '#dc2626',
  warning: '#d97706',
  success: '#059669',
  info: '#64748b',
};

function buildSnapshotSvg(event) {
  const seed = hashSeed(event.id || event.title || 'event');
  const accent = SEVERITY_COLORS[event.severity] || SEVERITY_COLORS.info;
  const w = 640;
  const h = 360;

  const boxW = 120 + (seed % 80);
  const boxH = 80 + (seed % 60);
  const boxX = 80 + (seed % (w - boxW - 160));
  const boxY = 50 + ((seed >> 3) % (h - boxH - 100));
  const conf = Math.round((event.confidence || 0.7) * 100);
  const label = String(event.title || 'Detection').slice(0, 28);
  const camera = String(event.camera || 'Camera').slice(0, 24);
  const time = String(event.timeLabel || '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Detection snapshot">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <path d="M0 4 L4 0" stroke="#ffffff" stroke-opacity="0.03"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#scan)"/>
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="none" stroke="${accent}" stroke-width="3" rx="2"/>
  <rect x="${boxX}" y="${boxY - 22}" width="${Math.min(label.length * 7 + 36, boxW + 40)}" height="20" fill="${accent}" rx="2"/>
  <text x="${boxX + 6}" y="${boxY - 8}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="600">${escapeXml(label)} ${conf}%</text>
  <text x="16" y="${h - 14}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="11">${escapeXml(camera)} · ${escapeXml(time)}</text>
  <circle cx="${w - 18}" cy="18" r="5" fill="#ef4444">
    <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite"/>
  </circle>
  <text x="${w - 30}" y="22" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="700" text-anchor="end">REC</text>
</svg>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  buildSnapshotSvg,
};
