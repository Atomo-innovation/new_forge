/**
 * WHEP WebRTC player — low-latency MediaMTX preview (<300ms glass-to-glass).
 */
(function (global) {
  async function connectWhep(whepUrl, videoEl, options = {}) {
    if (!whepUrl || !videoEl) throw new Error('whepUrl and video element required');

    const pc = new RTCPeerConnection({
      iceServers: options.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      bundlePolicy: 'max-bundle',
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (ev) => {
      if (ev.streams?.[0]) {
        videoEl.srcObject = ev.streams[0];
        videoEl.play().catch(() => {});
      }
    };

    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', check);
        setTimeout(resolve, 1500);
      });
    }

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });

    if (!res.ok) throw new Error(`WHEP failed (${res.status})`);

    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    return {
      pc,
      close() {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        videoEl.srcObject = null;
      },
    };
  }

  function resolveLocalUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url, window.location.origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        const board = document.body.dataset.boardIp;
        u.hostname = board || window.location.hostname;
      }
      return u.href;
    } catch {
      return url;
    }
  }

  global.WhepPlayer = { connectWhep, resolveLocalUrl };
})(window);
