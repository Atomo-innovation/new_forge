/**
 * Local person_cpu.py worker — fallback when vision backend worker crashes
 * (e.g. old backend still running person.py on x86 laptop).
 * On Khadas ARM + NPU, backend person.py is used instead — do not start local worker.
 */

const { spawn } = require('child_process');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', 'Backend_Atomo_fordge');
const SCRIPT = path.join(BACKEND_ROOT, 'detectors', 'person_cpu.py');
const workers = new Map();

function shouldUseLocalPersonWorker() {
  const { shouldUseLocalPersonWorker: platformCheck } = require('./person-detector-platform');
  if (process.env.FORCE_LOCAL_PERSON === '1') return true;
  return platformCheck();
}

function workerKey(backendCameraId) {
  return String(backendCameraId);
}

function startLocalPersonWorker(backendCameraId, rtspUrl, config = {}) {
  const key = workerKey(backendCameraId);
  if (workers.has(key)) {
    const w = workers.get(key);
    if (w.proc && !w.proc.killed) return { running: true, pid: w.proc.pid };
  }

  if (!rtspUrl) throw new Error('No local RTSP URL for person worker');

  const conf = config.confidence ?? 0.32;
  const args = [
    '--onnx', path.join(BACKEND_ROOT, 'models', 'yolov8n.onnx'),
    '--type', 'rtsp',
    '--device', rtspUrl,
    '--conf', String(conf),
    '--nms', '0.45',
    '--transport', 'tcp',
    '--jpeg-quality', String(config.jpegQuality ?? 75),
    '--json-stream',
  ];

  const proc = spawn('python3', [SCRIPT, ...args], {
    cwd: BACKEND_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  if (!proc.pid) throw new Error('Failed to spawn person_cpu.py');

  const entry = {
    proc,
    lastResult: null,
    fps: 0,
    inference_ms: 0,
    started_at: new Date().toISOString(),
  };
  workers.set(key, entry);

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const result = JSON.parse(trimmed);
        if (result.fps) entry.fps = result.fps;
        if (result.inference_ms) entry.inference_ms = result.inference_ms;
        entry.lastResult = {
          ...result,
          camera_id: backendCameraId,
          model_id: 'mdl_person',
          updated_at: new Date().toISOString(),
        };
      } catch {
        /* ignore */
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[local-person ${key}] ${msg}`);
  });

  proc.on('close', () => {
    workers.delete(key);
  });

  console.log(`[local-person] Started CPU worker pid=${proc.pid} rtsp=${rtspUrl}`);
  return { running: true, pid: proc.pid };
}

function stopLocalPersonWorker(backendCameraId) {
  const key = workerKey(backendCameraId);
  const w = workers.get(key);
  if (!w?.proc) return false;
  w.proc.kill('SIGTERM');
  workers.delete(key);
  return true;
}

function isLocalPersonWorkerRunning(backendCameraId) {
  const w = workers.get(workerKey(backendCameraId));
  return Boolean(w?.proc && !w.proc.killed);
}

function getLocalPersonWorkerResult(backendCameraId) {
  const w = workers.get(workerKey(backendCameraId));
  return w?.lastResult || null;
}

function updateLocalPersonWorkerConfig(backendCameraId, config = {}) {
  const rtspUrl = config.rtspUrl;
  if (!isLocalPersonWorkerRunning(backendCameraId)) return false;
  stopLocalPersonWorker(backendCameraId);
  startLocalPersonWorker(backendCameraId, rtspUrl, config);
  return true;
}

module.exports = {
  shouldUseLocalPersonWorker,
  startLocalPersonWorker,
  stopLocalPersonWorker,
  isLocalPersonWorkerRunning,
  getLocalPersonWorkerResult,
  updateLocalPersonWorkerConfig,
};
