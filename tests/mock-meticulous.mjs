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
// dial state driven by /api/v1/action/*: idle → heating → click to start → (brewing →) idle.
// POST /mock/dial { heatMs, tempFrom, brewMs } shapes the next cycle: how long the water
// takes to reach the loaded profile's temperature (ramping from tempFrom with a small
// overshoot), and whether a click at "click to start" runs a short brew (extracting).
const dial = { phase: 'idle', since: 0, loadedProfile: 'Blooming Espresso (demo)', loadedId: 'demo0001', actions: [], heatMs: 800, tempFrom: 25, brewMs: 0, temp: 92 };
const PROFILE_TEMP = { '80c5ea87': 92, '1a830a13': 93, demo0001: 93, dup00002: 93 };
const AI_KEY = process.env.MOCK_AI_KEY || 'sk-test-123';
const AI_REPORT = (n, noPortal) => `## Verdict

The trace is clean — EC rises smoothly through the rebuild, peaks once at 2.67 mS/cm with 2.6 g in the cup and falls away without a spike or a dip, so there is no sign of channeling. But it is not quite the shot the profile describes: the pump stopped at the scale's 40.0 g while the profile targets 38 g, and Extract ran at 9.2 bar from its first second instead of the 6–7 bar the profile notes aim for.

- Yield **40.0 g on the scale from 18.0 g** (profile target 38 g → 1 : 2.11 used for yield and EY)
- Extraction pressure reached **9.2 bar** at the start of Extract and was still 6.4 bar when the pump stopped
- **The bloom put nothing in the cup**; 4 % of the solubles had arrived by the end of the rebuild, 85 % by 30 g; the last 5 g carried 7 % of ∫EC dm at a third of the peak EC

Setup: Meticulous, Blooming Espresso (demo) at 93 °C, Zerno Z1 at 420 µm, Supernova (Hatch).

## Stages

| Stage | Time | Water in | Cup | What happened |
|---|---|---|---|---|
| Saturate | 0–1.9 s | 3 ml | 0 g | 1.6 ml/s took the puck to 2.8 bar; nothing in the cup. Water 92.5 → 92.7 °C. |
| Bloom | 2.0–5.9 s | 6 ml | 0 g | Flow stayed at 1.6 ml/s, so this was a slow pre-infusion rather than a rest: pressure only eased 2.8 → 2.4 bar. |
| Gentle Rebuild | 6.0–8.9 s | 2 ml | 0 → 1.1 g | Pressure jumped to 8.9 bar within 3 s at 0.7 ml/s; first drop at 8.4 s; EC 2.6 mS/cm by the end. |
| Extract | 9.0–29.9 s | 48 ml | 1.2 → 40.0 g | 2.3 ml/s; pressure 9.2 → 6.4 bar; EC 2.6 → 0.7. |
| Drips | 30.0–30.0 s | — | 40.0 g | The recording ended with the pump; no drips were captured. |

Where the solubles came from, as a share of ∫EC dm: 0 % by the end of the bloom, 4 % by the end of the rebuild, 52 % by 15 g, 76 % by 25 g, 93 % by 35 g.

## What stands out

1. **It ran 2 g past the target.** The scale read 40.0 g at pump stop against a 38 g profile target. On a flow profile the machine stops on predicted weight; 2 g over is more than drips explain.
   - Check which version of the profile is loaded and what its final weight says.
   - Unconfirmed: the tare may have drifted before the shot (the scale showed 0.0 g through the bloom, which argues against it).
2. **High extraction pressure.** 9.2 bar at 2.3 ml/s on an 18 g dose says the puck is on the fine side for this coffee; the profile's own notes want 6–7 bar after the bloom.
3. **The bloom did not rest.** Flow never dropped to zero and pressure never fell below 2.4 bar, so the rebuild started from a pressurised puck and hit 8.9 bar in three seconds.
4. **Temperature held.** 92.2–92.8 °C throughout against a 93 °C setpoint — nothing to change here.
5. **Data detail.** The shot carries no refractometer reading, so EC/g (1.63 mS/cm per g) cannot yet be turned into TDS for this coffee.

## Suggested changes

Change one thing per shot, in this order.

1. **Grind 10 µm coarser (two steps, to 430 µm).** Expect Extract to start nearer 7 bar and the decline to begin lower; shot time should stay close to 30 s because flow is commanded.
2. **If the yield is still over,** lower the profile's final weight by the overshoot you see (2 g), or set it to what you want in the cup and let the drips land on top.
3. **Give the bloom a rest:** set the Bloom stage's flow to 0 (keep its 4 s), or add a pressure exit at 1.5 bar, so the second half of the shot does more of the work.

## Open questions

- How did it taste? Harsh or drying points to the pressure; sour or thin would argue against going coarser.
- A refractometer reading on this coffee would let the app calibrate EC/g → TDS.
- Is 38 g or 40 g the intended yield for how you drink it?

## Sources

- Shot digest and one-second trace supplied by the app (mock review of ${n} shot${n === 1 ? '' : 's'}${noPortal ? ', one without Portal data' : ''})
- Profile "Blooming Espresso (demo)" as recorded by the machine
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
  if (req.url === '/api/v1/history/stats') return json(res, dial.hostile
    ? { totalSavedShots: '<img src=x onerror="window.__xss=(window.__xss||0)+1">', byProfile: [{ name: 'Evil <img src=x onerror="window.__xss=(window.__xss||0)+1">', count: '34<img src=x onerror="window.__xss=(window.__xss||0)+1">', profileVersions: '<b>3</b>' }, { name: 'Blooming Espresso', count: 14, profileVersions: 1 }], mileage: '<i onclick="1">109</i>' }
    : { totalSavedShots: 63, byProfile: [{ name: 'Blooming Espresso', count: 34, profileVersions: 3 }, { name: 'Blooming Espresso - Revolver', count: 14, profileVersions: 1 }], mileage: 109 });
  if (req.url === '/api/v1/history/last') { res.setHeader('Content-Type', 'application/json'); return res.end(saved ? JSON.stringify(saved).replace('"motor_speed": 1', '"motor_speed": NaN') : 'null'); }
  if (req.url === '/api/v1/history') return json(res, { history: saved ? [saved] : [] });
  if (req.url === '/api/v1/machine') return json(res, { name: 'MeticulousMock', hostname: 'mock-000001', firmware: '0.2.24-mock', mainVoltage: 120, serial: '000001', color: 'BLACK', batch_number: '0047', build_date: '2026-06-14T06:25:10Z', software_version: '2026-10-31', image_build_channel: 'beta', image_version: '2026M1510-beta', disturbance_resilience: false, disturbance_resilience_supported: true, tare_behavior_supported: true, pour_over_profiles_supported: true, pour_over_profile_schema_version: 1, repository_info: { backend: { branch: 'beta', commit: '0044ec9 - mock' }, firmware: { branch: 'beta', commit: '1891448a - mock' } }, version_history: ['beta-20261031_225605'] });
  const getProfile = req.url.match(/^\/api\/v1\/profile\/get\/([0-9a-zA-Z-]+)$/);
  if (getProfile || req.url === '/api/v1/profile/list?full=true') {
    const stagesFor = (target, bloom) => [
      { name: 'Saturate', key: 'saturate', type: 'flow', dynamics: { over: 'time', interpolation: 'linear', points: [[0, 4]] }, exit_triggers: [{ type: 'pressure', value: 4, relative: false, comparison: '>=' }, { type: 'time', value: 12, relative: true, comparison: '>=' }], limits: [] },
      { name: 'Bloom', key: 'bloom', type: 'flow', dynamics: { over: 'time', interpolation: 'linear', points: [[0, 0]] }, exit_triggers: [{ type: 'time', value: bloom, relative: true, comparison: '>=' }, { type: 'pressure', value: 1.5, relative: false, comparison: '<=' }], limits: [] },
      { name: 'Gentle Rebuild', key: 'rebuild', type: 'flow', dynamics: { over: 'time', interpolation: 'linear', points: [[0, 1], [4, 2]] }, exit_triggers: [{ type: 'time', value: 4, relative: true, comparison: '>=' }], limits: [] },
      { name: 'Extract', key: 'extract', type: 'flow', dynamics: { over: 'time', interpolation: 'linear', points: [[0, '$extraction_flow']] }, exit_triggers: [{ type: 'weight', value: target, relative: false, comparison: '>=' }], limits: [{ type: 'pressure', value: 7 }] },
    ];
    const full = {
      '80c5ea87': { id: '80c5ea87', name: 'Blooming Espresso', author: 'Robert Guerra', temperature: 92, final_weight: 43, last_changed: 1789974014, display: { accentColor: '#FA3012', shortDescription: 'Floral bloom', description: 'Start with 18.0 g, 43 g out; aim for 6-7 bar after the bloom.' }, variables: [{ name: 'Bloom Time', key: 'bloom_time', type: 'time', value: 20 }, { name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }], stages: stagesFor(43, '$bloom_time') },
      '1a830a13': { id: '1a830a13', name: 'Blooming - Hatch Supernova', author: 'Robert Guerra', temperature: 93, final_weight: 38, display: { accentColor: '#433C36' }, variables: [{ name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2.3 }], stages: stagesFor(38, 12) },
      demo0001: { id: 'demo0001', name: 'Blooming Espresso (demo)', author: 'mock', temperature: 93, final_weight: 38, display: { accentColor: '#2447B8' }, variables: [{ name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }], stages: stagesFor(38, 20) },
      dup00002: { id: 'dup00002', name: 'Blooming Espresso', author: 'Robert Guerra', temperature: 93, final_weight: '$final_weight', last_changed: 1789900000, display: { accentColor: '#FA3012' }, variables: [{ name: 'Final weight', key: 'final_weight', type: 'weight', value: 38 }, { name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }], stages: stagesFor('$final_weight', 15) },
    };
    if (getProfile) {
      if (!full[getProfile[1]]) { res.statusCode = 404; return json(res, { status: 'error', error: 'profile not found', id: getProfile[1] }); }
      return json(res, full[getProfile[1]]);
    }
    return json(res, Object.values(full));
  }
  if (req.url === '/api/v1/profile/list') return json(res, [{ id: '80c5ea87', name: 'Blooming Espresso', author: 'Robert Guerra', temperature: 92, final_weight: 43, last_changed: 1789974014, display: { accentColor: '#FA3012', shortDescription: 'Floral bloom', description: 'Start with 18.0 g, 43 g out.', image: '/api/v1/profile/image/x.jpeg' }, variables: [{ name: 'Bloom Time', key: 'bloom_time', type: 'time', value: 20 }, { name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }] }, { id: '1a830a13', name: 'Blooming - Hatch Supernova', author: 'Robert Guerra', temperature: 93, final_weight: 38, display: { accentColor: '#433C36' }, variables: [] }, { id: 'demo0001', name: 'Blooming Espresso (demo)', author: 'mock', temperature: 93, final_weight: 38, display: { accentColor: '#2447B8' }, variables: [] }, { id: 'dup00002', name: 'Blooming Espresso', author: 'Robert Guerra', temperature: 93, final_weight: '$final_weight', last_changed: 1789900000, display: { accentColor: '#FA3012' }, variables: [{ name: 'Final weight', key: 'final_weight', type: 'weight', value: 38 }] }]); // a second "Blooming Espresso": same name, 38 g via a variable
  if (req.url === '/api/v1/settings') return json(res, { enable_sounds: true, heat_on_boot: true, heating_timeout: 10, update_channel: 'beta', tare_behavior: 'after_retraction', time_zone: 'America/Toronto', clock_format_24_hour: true, disturbance_resilience: false, partial_retraction: 45.33 });
  if (req.url === '/api/v1/wifi/config' && dial.hostile) return json(res, { config: { mode: '<b>CLIENT</b>', apName: 'Mock' }, status: { connected: true, connection_name: 'Home <img src=x onerror="window.__xss=(window.__xss||0)+1">', gateway: '<script>window.__xss=99</script>', ips: ['192.168.1.50<img src=x onerror="window.__xss=(window.__xss||0)+1">'], dns: [], mac: '"><img src=x onerror="window.__xss=(window.__xss||0)+1">', hostname: 'mock' }, health: { link_connected: true, has_ipv4: true, message: 'note <img src=x onerror="window.__xss=(window.__xss||0)+1">' } });
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
      if (dial.phase === 'idle') { dial.phase = 'heating'; dial.since = Date.now(); dial.heatFrom = dial.temp; }
      else if (dial.phase === 'ready') { dial.phase = dial.brewMs > 0 ? 'brewing' : 'idle'; dial.since = Date.now(); dial.started = Date.now(); } // with brewMs the mock runs a short brew; the scripted shot is the one at boot
      else { res.statusCode = 409; return json(res, { status: 'error', action: name }); }
    } else if (name === 'preheat') { dial.phase = 'preheat'; dial.since = Date.now(); dial.heatFrom = dial.temp; }
    else if (name === 'abort' || name === 'stop' || name === 'home') { dial.phase = 'idle'; if (name === 'abort') return res.end(); }
    return json(res, { action: name, status: 'ok' });
  }
  const load = req.url.match(/^\/api\/v1\/profile\/load\/([0-9a-zA-Z-]+)$/);
  if (load) {
    const list = { '80c5ea87': 'Blooming Espresso', '1a830a13': 'Blooming - Hatch Supernova', demo0001: 'Blooming Espresso (demo)', dup00002: 'Blooming Espresso' };
    if (!list[load[1]]) { res.statusCode = 404; return json(res, { status: 'error', error: 'profile not found', id: load[1] }); }
    if (dial.phase !== 'idle') { res.statusCode = 409; return json(res, { status: 'error', error: 'machine is busy' }); }
    dial.loadedProfile = list[load[1]];
    dial.loadedId = load[1];
    return json(res, { name: dial.loadedProfile, id: load[1] });
  }
  if (req.url === '/mock/dial' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const o = JSON.parse(body || '{}');
        for (const k of ['heatMs', 'tempFrom', 'brewMs']) if (Number.isFinite(Number(o[k]))) dial[k] = Number(o[k]);
        if (Number.isFinite(Number(o.temp))) dial.temp = Number(o.temp);
        if ('hostile' in o) dial.hostile = !!o.hostile; // answer the Wi-Fi and statistics requests with markup in every string (and a string where a number belongs)
        json(res, dial);
      } catch (e) { res.statusCode = 400; json(res, { error: e.message }); }
    });
    return;
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
      let text = /Answer with the single word OK/.test(body.messages?.[0]?.content || '') ? 'OK' : AI_REPORT(n, noPortal);
      // model "cut-model": the first answer stops at the output limit half way (finish_reason "length");
      // a request that continues the conversation (an assistant turn, then "continue") gets the rest.
      let finish = 'stop';
      const prior = body.messages?.filter((m) => m.role === 'assistant').map((m) => m.content).join('') || '';
      dial.lastAiRequest.turns = body.messages?.length || 0;
      if (body.model === 'cut-model' && text !== 'OK') {
        const half = Math.floor(text.length / 2);
        if (prior) text = text.slice(prior.length); // the remainder, exactly where it stopped
        else { text = text.slice(0, half); finish = 'length'; }
      }
      if (!body.stream) return json(res, { id: 'chatcmpl-mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }] });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const chunks = text.match(/[^]{1,40}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i++] }, finish_reason: null }] })}\n\n`);
        else { clearInterval(timer); res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); }
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
  const target = PROFILE_TEMP[dial.loadedId] || 93;
  const now = Date.now();
  if ((dial.phase === 'heating' || dial.phase === 'preheat') && now - dial.since >= dial.heatMs) dial.phase = dial.phase === 'heating' ? 'ready' : 'idle';
  if (dial.phase === 'brewing' && now - dial.since >= dial.brewMs) { dial.phase = 'idle'; dial.temp = target - 1.2; }
  if (dial.phase === 'heating' || dial.phase === 'preheat') {
    // ramp from where it started to the target, with a 0.4 °C overshoot that settles in the last 15 %
    const p = Math.min(1, (now - dial.since) / dial.heatMs);
    const from = dial.heatFrom ?? dial.tempFrom;
    dial.temp = p < 0.85 ? from + (target - from) * (p / 0.85) : target + 0.4 * Math.sin(((p - 0.85) / 0.15) * Math.PI);
  } else if (dial.phase === 'ready') dial.temp = target + 0.1 * Math.sin(now / 700);
  else if (dial.phase === 'brewing') dial.temp = target - 0.5 - ((now - dial.since) / dial.brewMs) * 0.7;
  const brewing = dial.phase === 'brewing' ? (now - dial.since) / 1000 : null;
  const dialPayload = dial.phase === 'heating' || dial.phase === 'preheat' ? { name: 'heating', state: 'brewing' }
    : dial.phase === 'ready' ? { name: 'click to start', state: 'brewing' }
    : dial.phase === 'brewing' ? { name: brewing < 0.5 ? 'Saturate' : 'Extract', state: 'brewing', extracting: true, time: Math.round(brewing * 1000), profile_time: Math.round(brewing * 1000), sensors: { p: 2 + brewing * 4, f: 1.5, w: brewing * 1.8, t: dial.temp, g: 1.5 }, setpoints: { active: 'flow', flow: 1.5 } }
    : null;
  if (elapsed < 0) {
    payload = { name: 'idle', state: 'idle', extracting: false, time: -1, profile: dial.loadedProfile, loaded_profile: dial.loadedProfile, id: dial.loadedId, profile_time: -1, sensors: { p: 0, f: 0, w: 0, t: Math.round(dial.temp * 10) / 10, g: 0 }, setpoints: { active: null } };
  } else if (idx < shot.machine.length) {
    while (idx < shot.machine.length - 1 && shot.machine[idx + 1].t <= elapsed) idx++;
    const s = shot.machine[idx];
    const extracting = s.t < shot.durationSec;
    payload = { name: s.status, state: extracting ? 'brewing' : 'idle', extracting, time: Math.round(s.t * 1000), profile: shot.profileName, loaded_profile: shot.profileName, id: 'demo0001', profile_time: Math.round(s.t * 1000), sensors: { p: s.p, f: s.f, w: s.w, t: s.temp, g: s.g }, setpoints: { active: 'pressure', pressure: 9 } };
    if (idx === shot.machine.length - 1) idx++;
  } else {
    if (!saved) {
      saved = {
        id: 'saved-42',
        time: startEpoch,
        profile_name: shot.profileName,
        profile: { id: 'demo0001', name: shot.profileName, temperature: 93, final_weight: 38 }, // the scale ends at ~40 g: target + drips
        data: shot.machine.map((s) => ({ time: Math.round(s.t * 1000), profile_time: Math.round(s.t * 1000), status: s.t < 2 ? 'Saturate' : s.t < 6 ? 'Bloom' : s.t < 9 ? 'Gentle Rebuild' : s.t < shot.durationSec ? 'Extract' : 'retracting', shot: { pressure: s.p, flow: s.f, weight: s.w, gravimetric_flow: s.g, setpoints: { active: 'flow', flow: 2, pressure: 7 } }, sensors: { external_1: 102.95, external_2: 103.43, bar_up: 83.99, tube: 86.35, motor_temp: 29.31, motor_speed: 1, motor_position: 40.96, motor_power: 25.77, bandheater_power: 0.0 } })),
      };
      console.log('saved shot available');
    }
    payload = { name: 'idle', state: 'idle', extracting: false, time: -1, profile: dial.loadedProfile, loaded_profile: dial.loadedProfile, id: dial.loadedId, profile_time: -1, sensors: { p: 0, f: 0, w: shot.finalWeightG, t: Math.round(dial.temp * 10) / 10, g: 0 }, setpoints: { active: null } };
  }
  if (dialPayload && !payload.extracting) payload = { ...payload, ...dialPayload, sensors: dialPayload.sensors || { ...payload.sensors, t: Math.round(dial.temp * 10) / 10 } };
  io.emit('status', payload);
  const e = (Date.now() - t0) / 1000;
  io.emit('sensors', { t_ext_1: 102.9 + Math.sin(e / 5), t_ext_2: 103.4 + Math.cos(e / 7), t_bar_up: 84, t_bar_mu: 87.9, t_bar_md: 88.3, t_bar_down: 85.1, t_tube: 86.3, t_motor_temp: 29.3, lam_temp: 29.7, p: 299, m_pos: elapsed > 0 && elapsed < 30 ? elapsed * 1.5 : 0, m_spd: 1.79, m_pwr: elapsed > 0 && elapsed < 30 ? 25 : 0, m_cur: 0.8, bh_pwr: 30 + 20 * Math.sin(e / 3), bh_cur: 0.03, w_stat: true, motor_temp: 29.3, weight_pred: 0 });
}, 100);
