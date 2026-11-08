// demo.js — a synthetic Meticulous + Portal shot so the app can be exercised
// without hardware. Shapes are plausible, not measured: a 6 s bloom at low
// pressure, a ramp to ~9 bar, declining pressure to the end, first drops at
// ~7 s, EC peaking shortly after the first drops and decaying through the shot.

export function makeDemoShot({ durationSec = 30, doseG = 18, targetG = 40, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const machine = [];
  const portal = [];
  const dt = 0.1; // machine status ~10 Hz
  let weight = 0;
  let water = 0;
  for (let t = 0; t <= durationSec + 1e-9; t += dt) {
    const bloom = t < 6;
    const pressure = bloom ? 2.5 + 0.3 * Math.sin(t) : Math.min(9.2, 2.5 + (t - 6) * 2.2) - Math.max(0, (t - 14) * 0.18);
    const flow = bloom ? 1.6 : t < 8 ? 0.6 : Math.min(2.4, 0.8 + (t - 8) * 0.35);
    water += flow * dt;
    const outFlow = t < 7 ? 0 : Math.min(2.2, (t - 7) * 0.6);
    weight = Math.min(targetG, weight + outFlow * dt + (rnd() - 0.5) * 0.02);
    machine.push({
      t: round(t, 3),
      p: round(Math.max(0, pressure + (rnd() - 0.5) * 0.08), 3),
      f: round(Math.max(0, flow + (rnd() - 0.5) * 0.06), 3),
      w: round(Math.max(0, weight), 2),
      g: round(outFlow, 3),
      temp: round(92.5 + Math.sin(t / 3) * 0.3, 2),
      status: bloom ? 'Bloom' : t < 14 ? 'Ramp' : 'Decline',
    });
  }
  // Portal notifications ~8 Hz, slightly irregular, EC follows coffee concentration
  let tp = 0;
  while (tp <= durationSec + 0.3) {
    const since = tp - 7.2; // liquid reaches the Portal ~0.2 s before the cup
    let ec = 0;
    if (since > 0) ec = 3.1 * (1 - Math.exp(-since / 0.9)) * Math.exp(-since / 11) + 0.35;
    const tOut = since > 0 ? 62 + 4 * Math.min(1, since / 3) - since * 0.15 : 24 + since * 2;
    portal.push({ t: round(tp, 3), ec: round(Math.max(0, ec + (rnd() - 0.5) * 0.03), 4), tOut: round(tOut, 2), tInt: round(31 + tp * 0.05, 2), status: 87 });
    tp += 0.125 + (rnd() - 0.5) * 0.02;
  }
  const startedAt = Date.now() - durationSec * 1000;
  return {
    id: 'demo-' + seed,
    startedAt,
    durationSec,
    profileName: 'Blooming Espresso (demo)',
    profileTemperatureC: 93,
    finalWeightG: round(weight, 1),
    machine,
    portal,
    source: 'demo',
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
