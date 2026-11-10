// mock-meticulous.mjs — a stand-in for the machine: socket.io "status" and
// "sensors" at 10 Hz, the REST endpoints the app uses, one synthetic shot that
// starts 3 s after boot and lasts 30 s, the dial actions (start / abort /
// preheat / tare) and profile loading. It also answers as an OpenAI-compatible
// chat endpoint (/v1/models, /v1/chat/completions with SSE) so the AI review
// can be exercised offline. Needs `npm i socket.io`.
//   PORT=8080 node tests/mock-meticulous.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
// socket.io may be installed locally (npm i -D socket.io) or on NODE_PATH.
const require = createRequire(import.meta.url);
let Server;
try {
  ({ Server } = require('socket.io'));
} catch {
  const p = (process.env.NODE_PATH || '').split(':').filter(Boolean).map((d) => `${d}/socket.io`).find((d) => { try { require.resolve(d); return true; } catch { return false; } });
  if (!p) { console.error('socket.io is not installed: npm i -D socket.io'); process.exit(2); }
  ({ Server } = require(p));
}
import { makeDemoShot } from '../js/demo.js';

const PORT = Number(process.env.PORT) || 8080;
const shot = makeDemoShot({ seed: 42 });
const startEpoch = Date.now() / 1000 + 3; // shot starts 3 s after boot
let saved = null;
// dial state driven by /api/v1/action/*: idle → heating → click to start → (idle again on abort)
const dial = { phase: 'idle', since: 0, loadedProfile: 'Blooming Espresso (demo)', actions: [] };
const AI_KEY = process.env.MOCK_AI_KEY || 'sk-test-123';
const AI_REPORT = (n, noPortal) => `## Verdict

The trace is clean and the shot ran as the profile describes (mock review of ${n} shot${n === 1 ? '' : 's'}${noPortal ? ', one without Portal data' : ''}).

- Yield **40.0 g from 18.0 g (1 : 2.22)**
- Extraction pressure peaked at **9.2 bar**

Setup: Meticulous, Blooming Espresso (demo), 420 µm.

## Stages

| Stage | Time | Water in | Cup | What happened |
|---|---|---|---|---|
| Saturate | 0–2 s | 3 ml | 0 g | Filling. |
| Bloom | 2–6 s | 6 ml | 0 → 0 g | Resting. |
| Extract | 9–30 s | 40 ml | 2 → 40 g | Steady. |

## What stands out

1. **Nothing alarming.** The mock shot is synthetic.
   - Unconfirmed: the grinder may have drifted.

## Suggested changes

Change one thing per shot, in this order.

1. **Leave it alone.** Pull it again and taste.

## Open questions

- How did it taste?

## Sources

- Shot digest supplied by the app
`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/api/v1/history/stats') return json(res, { totalSavedShots: 63, byProfile: [{ name: 'Blooming Espresso', count: 34, profileVersions: 3 }, { name: 'Blooming Espresso - Revolver', count: 14, profileVersions: 1 }], mileage: 109 });
  if (req.url === '/api/v1/history/last') { res.setHeader('Content-Type', 'application/json'); return res.end(saved ? JSON.stringify(saved).replace('"motor_speed": 1', '"motor_speed": NaN') : 'null'); }
  if (req.url === '/api/v1/history') return json(res, { history: saved ? [saved] : [] });
  if (req.url === '/api/v1/machine') return json(res, { name: 'MeticulousMock', hostname: 'mock-000001', firmware: '0.2.24-mock', mainVoltage: 120, serial: '000001', color: 'BLACK', batch_number: '0047', build_date: '2026-06-14T06:25:10Z', software_version: '2026-10-31', image_build_channel: 'beta', image_version: '2026M1510-beta', disturbance_resilience: false, disturbance_resilience_supported: true, tare_behavior_supported: true, pour_over_profiles_supported: true, pour_over_profile_schema_version: 1, repository_info: { backend: { branch: 'beta', commit: '0044ec9 - mock' }, firmware: { branch: 'beta', commit: '1891448a - mock' } }, version_history: ['beta-20261031_225605'] });
  if (req.url === '/api/v1/profile/list') return json(res, [{ id: '80c5ea87', name: 'Blooming Espresso', author: 'Robert Guerra', temperature: 92, final_weight: 43, last_changed: 1789974014, display: { accentColor: '#FA3012', shortDescription: 'Floral bloom', description: 'Start with 18.0 g, 43 g out.', image: '/api/v1/profile/image/x.jpeg' }, variables: [{ name: 'Bloom Time', key: 'bloom_time', type: 'time', value: 20 }, { name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }] }, { id: '1a830a13', name: 'Blooming - Hatch Supernova', author: 'Robert Guerra', temperature: 93, final_weight: 38, display: { accentColor: '#433C36' }, variables: [] }, { id: 'demo0001', name: 'Blooming Espresso (demo)', author: 'mock', temperature: 93, final_weight: 38, display: { accentColor: '#2447B8' }, variables: [] }]);
  if (req.url === '/api/v1/settings') return json(res, { enable_sounds: true, heat_on_boot: true, heating_timeout: 10, update_channel: 'beta', tare_behavior: 'after_retraction', time_zone: 'America/Toronto', clock_format_24_hour: true, disturbance_resilience: false, partial_retraction: 45.33 });
  if (req.url === '/api/v1/wifi/config') return json(res, { config: { mode: 'CLIENT', apName: 'Mock' }, status: { connected: true, connection_name: 'HomeWiFi', gateway: '192.168.1.1', ips: ['192.168.1.50', 'fe80::1'], dns: ['192.168.1.1'], mac: '00:11:22:33:44:55', hostname: 'mock-000001' }, health: { mode: 'CLIENT', link_connected: true, has_ipv4: true, gateway_reachable: false, dns_resolves: false, internet_reachable: false, degraded: false, message: '' } });
  if (req.url === '/api/v1/notifications') return json(res, []);
  // ---- dial actions (backend api/action.py)
  const act = req.url.match(/^\/api\/v1\/action\/([a-z_]+)$/);
  if (act) {
    const name = act[1];
    const allowed = ['start', 'stop', 'tare', 'scale_master_calibration', 'preheat', 'continue', 'finish', 'home', 'purge', 'reset', 'abort'];
    dial.actions.push(name);
    if (!allowed.includes(name)) { res.statusCode = 400; return json(res, { status: 'error', action: name, allowed_actions: allowed }); }
    if (name === 'start') {
      if (dial.phase === 'idle') { dial.phase = 'heating'; dial.since = Date.now(); }
      else if (dial.phase === 'ready') { dial.phase = 'idle'; dial.started = Date.now(); } // the shot would begin here; the mock's scripted shot is the one at boot
      else { res.statusCode = 409; return json(res, { status: 'error', action: name }); }
    } else if (name === 'preheat') { dial.phase = 'preheat'; dial.since = Date.now(); }
    else if (name === 'abort' || name === 'stop' || name === 'home') { dial.phase = 'idle'; if (name === 'abort') return res.end(); }
    return json(res, { action: name, status: 'ok' });
  }
  const load = req.url.match(/^\/api\/v1\/profile\/load\/([0-9a-zA-Z-]+)$/);
  if (load) {
    const list = { '80c5ea87': 'Blooming Espresso', '1a830a13': 'Blooming - Hatch Supernova', demo0001: 'Blooming Espresso (demo)' };
    if (!list[load[1]]) { res.statusCode = 404; return json(res, { status: 'error', error: 'profile not found', id: load[1] }); }
    if (dial.phase !== 'idle') { res.statusCode = 409; return json(res, { status: 'error', error: 'machine is busy' }); }
    dial.loadedProfile = list[load[1]];
    return json(res, { name: dial.loadedProfile, id: load[1] });
  }
  if (req.url === '/mock/dial') return json(res, dial);
  // ---- OpenAI-compatible chat endpoint for the AI review
  if (req.url === '/v1/models') {
    if (req.headers.authorization !== `Bearer ${AI_KEY}`) { res.statusCode = 401; return json(res, { error: { message: 'Incorrect API key provided' } }); }
    return json(res, { object: 'list', data: [{ id: 'mock-gpt-2', object: 'model', created: 2 }, { id: 'mock-gpt-1', object: 'model', created: 1 }, { id: 'tts-1', object: 'model', created: 3 }] });
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    return readBody(req).then((raw) => {
      if (req.headers.authorization !== `Bearer ${AI_KEY}`) { res.statusCode = 401; return json(res, { error: { message: 'Incorrect API key provided' } }); }
      let body;
      try { body = JSON.parse(raw); } catch { res.statusCode = 400; return json(res, { error: { message: 'bad json' } }); }
      dial.lastAiRequest = { model: body.model, systemChars: body.messages?.[0]?.content?.length || 0, userChars: body.messages?.[1]?.content?.length || 0, stream: !!body.stream };
      if (body.model === 'bad-model') { res.statusCode = 404; return json(res, { error: { message: `The model \`${body.model}\` does not exist` } }); }
      const user = body.messages?.[1]?.content || '';
      const n = Number((user.match(/Shots to review: (\d+)/) || [])[1] || 0);
      const noPortal = /No Belka Portal data for this shot/.test(user);
      const text = /Answer with the single word OK/.test(body.messages?.[0]?.content || '') ? 'OK' : AI_REPORT(n, noPortal);
      if (!body.stream) return json(res, { id: 'chatcmpl-mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const chunks = text.match(/[^]{1,40}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i++] }, finish_reason: null }] })}\n\n`);
        else { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
      }, 15);
    });
  }
  if (req.url.startsWith('/api/v1/profile/image/')) { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="120"><rect width="96" height="120" fill="#FA3012"/></svg>'); }
  res.statusCode = 404;
  res.end('nope');
});
function json(res, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
const io = new Server(server, { cors: { origin: '*' } });
server.listen(PORT, '127.0.0.1', () => console.log('mock meticulous on', PORT));

const t0 = Date.now();
let idx = 0;
setInterval(() => {
  const elapsed = (Date.now() - t0) / 1000 - 3;
  let payload;
  if (dial.phase === 'heating' && Date.now() - dial.since > 800) dial.phase = 'ready';
  if (dial.phase === 'preheat' && Date.now() - dial.since > 800) dial.phase = 'idle';
  const dialPayload = dial.phase === 'heating' || dial.phase === 'preheat' ? { name: 'heating', state: 'brewing' } : dial.phase === 'ready' ? { name: 'click to start', state: 'brewing' } : null;
  if (elapsed < 0) {
    payload = { name: 'idle', state: 'idle', extracting: false, time: -1, profile: dial.loadedProfile, profile_time: -1, sensors: { p: 0, f: 0, w: 0, t: 92, g: 0 }, setpoints: { active: null } };
  } else if (idx < shot.machine.length) {
    while (idx < shot.machine.length - 1 && shot.machine[idx + 1].t <= elapsed) idx++;
    const s = shot.machine[idx];
    const extracting = s.t < shot.durationSec;
    payload = { name: s.status, state: extracting ? 'brewing' : 'idle', extracting, time: Math.round(s.t * 1000), profile: shot.profileName, profile_time: Math.round(s.t * 1000), sensors: { p: s.p, f: s.f, w: s.w, t: s.temp, g: s.g }, setpoints: { active: 'pressure', pressure: 9 } };
    if (idx === shot.machine.length - 1) idx++;
  } else {
    if (!saved) {
      saved = {
        id: 'saved-42',
        time: startEpoch,
        profile_name: shot.profileName,
        profile: { name: shot.profileName, temperature: 93, final_weight: 38 }, // the scale ends at ~40 g: target + drips
        data: shot.machine.map((s) => ({ time: Math.round(s.t * 1000), profile_time: Math.round(s.t * 1000), status: s.t < 2 ? 'Saturate' : s.t < 6 ? 'Bloom' : s.t < 9 ? 'Gentle Rebuild' : s.t < shot.durationSec ? 'Extract' : 'retracting', shot: { pressure: s.p, flow: s.f, weight: s.w, gravimetric_flow: s.g, setpoints: { active: 'flow', flow: 2, pressure: 7 } }, sensors: { external_1: 102.95, external_2: 103.43, bar_up: 83.99, tube: 86.35, motor_temp: 29.31, motor_speed: 1, motor_position: 40.96, motor_power: 25.77, bandheater_power: 0.0 } })),
      };
      console.log('saved shot available');
    }
    payload = { name: 'idle', state: 'idle', extracting: false, time: -1, profile: dial.loadedProfile, profile_time: -1, sensors: { p: 0, f: 0, w: shot.finalWeightG, t: 92, g: 0 }, setpoints: { active: null } };
  }
  if (dialPayload && !payload.extracting) payload = { ...payload, ...dialPayload, sensors: { ...payload.sensors, t: 93.4 } };
  io.emit('status', payload);
  const e = (Date.now() - t0) / 1000;
  io.emit('sensors', { t_ext_1: 102.9 + Math.sin(e / 5), t_ext_2: 103.4 + Math.cos(e / 7), t_bar_up: 84, t_bar_mu: 87.9, t_bar_md: 88.3, t_bar_down: 85.1, t_tube: 86.3, t_motor_temp: 29.3, lam_temp: 29.7, p: 299, m_pos: elapsed > 0 && elapsed < 30 ? elapsed * 1.5 : 0, m_spd: 1.79, m_pwr: elapsed > 0 && elapsed < 30 ? 25 : 0, m_cur: 0.8, bh_pwr: 30 + 20 * Math.sin(e / 3), bh_cur: 0.03, w_stat: true, motor_temp: 29.3, weight_pred: 0 });
}, 100);
