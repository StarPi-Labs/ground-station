const test = require('node:test');
const assert = require('node:assert/strict');
const { FlightTracker, LinkSelector, distanceBearing, lateral, phaseOf, G, MG_PER_G } = require('./flight-state.js');

// A flight like the backend simulator's: 20 s on the pad, 2.2 s burn at 4 g,
// coast to ~285 m, 8 m/s under the drogue, the main below 100 m at 5 m/s,
// then on the ground. The rocket reports its state once a second and on
// every change, as the simulator does.
const PAD_ALT = 120;
const BURN_S = 2.2;
const BURN = 4 * G;
const V0 = (BURN - G) * BURN_S;
const H0 = 0.5 * (BURN - G) * BURN_S ** 2;
const APOGEE_T = 20 + BURN_S + V0 / G;
const APOGEE = H0 + V0 ** 2 / (2 * G);
const MAIN_H = 100;
const MAIN_T = APOGEE_T + (APOGEE - MAIN_H) / 8;
const LANDING_T = MAIN_T + MAIN_H / 5;

// The accelerometer reports milli-g.
const mg = (a) => (a / G) * MG_PER_G;

function ideal(t) {
    if (t < 20) return { h: 0, v: 0, a: G, state: 'RS_IDLE' };
    if (t < 20 + BURN_S) {
        const dt = t - 20;
        return { h: 0.5 * (BURN - G) * dt ** 2, v: (BURN - G) * dt, a: BURN, state: 'RS_BOOST' };
    }
    if (t < APOGEE_T) {
        const dt = t - 20 - BURN_S;
        return { h: H0 + V0 * dt - 0.5 * G * dt ** 2, v: V0 - G * dt, a: 0.4, state: 'RS_COAST' };
    }
    if (t < MAIN_T) return { h: APOGEE - 8 * (t - APOGEE_T), v: -8, a: G, state: 'RS_DROGUE' };
    if (t < LANDING_T) return { h: MAIN_H - 5 * (t - MAIN_T), v: -5, a: G, state: 'RS_MAIN' };
    return { h: 0, v: 0, a: G, state: 'RS_TOUCHDOWN' };
}

// Deterministic noise, so a failing run can be reproduced.
function rng(seed) {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648 - 0.5;
    };
}

/** Feed `tracker` the flight from `from` to `until` s, `offset` s later; returns the tracker. */
function fly({ tracker = new FlightTracker(), rate = 5, noise = 0, from = 0, until = 90, offset = 0, gap = null, skip = null } = {}) {
    const random = rng(42);
    let state = null;
    let stateAt = -Infinity;
    for (let i = Math.round(from * rate); i <= until * rate; i++) {
        const t = i / rate;
        if (gap && t >= gap[0] && t < gap[1]) continue;
        const s = ideal(t);
        const ms = (offset + t) * 1000;
        if ((s.state !== state || t - stateAt >= 1) && s.state !== skip) {
            tracker.update({ t: ms, kind: 'state', state: s.state });
            state = s.state;
            stateAt = t;
        }
        tracker.update({ t: ms, kind: 'accel', x: 0, y: 0, z: mg(s.a + noise * 1.2 * random()) });
        tracker.update({ t: ms, kind: 'alt', altitude: PAD_ALT + s.h + noise * random(), speed: s.v + noise * random() });
    }
    return tracker;
}

const phases = (snapshot) => snapshot.events.map((e) => e.phase);
const near = (actual, expected, tolerance, what) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);

test('phaseOf reads the rocket state by name or ordinal', () => {
    assert.equal(phaseOf('RS_BOOST'), 'BOOST');
    assert.equal(phaseOf(4), 'MAIN');
    assert.equal(phaseOf('RS_SOMETHING_NEW'), null);
    assert.equal(phaseOf(9), null);
});

test('the reported states make the phase, launch time and events', () => {
    const s = fly().snapshot();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    assert.equal(s.phase, 'TOUCHDOWN');
    near(s.launchTime, 20000, 200, 'launch');
    near(s.events.find((e) => e.phase === 'MAIN').t, MAIN_T * 1000, 200, 'main');
    near(s.apogee.agl, APOGEE, 2, 'apogee');
    near(s.apogee.t, APOGEE_T * 1000, 200, 'apogee time');
    assert.ok(s.maxAccelG > 3.9 && s.maxAccelG < 4.1, `max accel ${s.maxAccelG}`);
    near(s.ground, PAD_ALT, 0.01, 'ground');
});

test('no state yet: no phase, but the ground level is measured', () => {
    const tracker = new FlightTracker();
    for (let t = 0; t < 10000; t += 200) {
        tracker.update({ t, kind: 'alt', altitude: PAD_ALT, speed: 0 });
    }
    const s = tracker.snapshot();
    assert.equal(s.phase, null);
    assert.equal(s.launchTime, null);
    assert.equal(s.ground, PAD_ALT);
});

test('noisy sensors: ground and apogee within a few metres', () => {
    const s = fly({ noise: 0.8 }).snapshot();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    near(s.apogee.agl, APOGEE, 3, 'apogee');
    near(s.ground, PAD_ALT, 0.5, 'ground');
});

test('a missed state still marks the launch', () => {
    // No BOOST report: leaving IDLE for COAST is the launch.
    const s = fly({ skip: 'RS_BOOST' }).snapshot();
    assert.deepEqual(phases(s), ['COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    near(s.launchTime, (20 + BURN_S) * 1000, 200, 'launch');
});

test('a telemetry gap across the burn dates the launch to the first sample back', () => {
    const s = fly({ gap: [19.8, 23] }).snapshot();
    assert.deepEqual(phases(s), ['COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    assert.equal(s.launchTime, 23000);
    near(s.apogee.agl, APOGEE, 2, 'apogee');
});

test('first state seen mid-flight: no launch time, and no ground from flight altitudes', () => {
    const s = fly({ from: 30 }).snapshot();
    assert.equal(s.launchTime, null);
    assert.equal(s.ground, PAD_ALT, 'ground measured after touchdown');
    assert.deepEqual(phases(s), ['DROGUE', 'MAIN', 'TOUCHDOWN']);
});

test('a second flight after touchdown resets the records', () => {
    const tracker = fly();
    fly({ tracker, offset: 90 });
    const s = tracker.snapshot();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    near(s.launchTime, 110000, 200, 'second launch');
    near(s.apogee.t, (90 + APOGEE_T) * 1000, 200, 'second apogee');
});

test('samples older than the last one are ignored', () => {
    const tracker = new FlightTracker();
    assert.equal(tracker.update({ t: 1000, kind: 'alt', altitude: 100, speed: 0 }), true);
    assert.equal(tracker.update({ t: 500, kind: 'alt', altitude: 999, speed: 0 }), false);
    assert.equal(tracker.snapshot().altitude, 100);
});

test('the cached pad median follows every sample, through a touchdown and relaunch', () => {
    const { median } = require('./flight-state.js');
    const tracker = new FlightTracker();
    const random = rng(7);
    let state = null;
    for (let i = 0; i < 2 * 90 * 5; i++) {
        const t = (i % (90 * 5)) / 5; // two flights back to back
        const s = ideal(t);
        const ms = i * 200;
        if (s.state !== state) {
            tracker.update({ t: ms, kind: 'state', state: s.state });
            state = s.state;
        }
        tracker.update({ t: ms, kind: 'alt', altitude: PAD_ALT + s.h + 2 * random(), speed: s.v });
        const expected = tracker.frozenGround ?? (tracker.groundSamples.length ? median(tracker.groundSamples) : null);
        assert.equal(tracker.ground, expected, `at sample ${i}, phase ${tracker.phase}`);
    }
    assert.equal(tracker.events.filter((e) => e.phase === 'BOOST').length, 1, 'second flight after touchdown');
});

test('pinned ground level overrides the pad median', () => {
    const tracker = new FlightTracker();
    tracker.update({ t: 0, kind: 'alt', altitude: 130, speed: 0 });
    tracker.setGround(100);
    assert.equal(tracker.snapshot().agl, 30);
    tracker.setGround(null);
    assert.equal(tracker.snapshot().agl, 0);
});

test('pad position and distance from it', () => {
    const tracker = new FlightTracker();
    tracker.update({ t: 0, kind: 'gps', lat: 45.4642, lon: 9.19 });
    tracker.update({ t: 1, kind: 'gps', lat: 0, lon: 0 }); // no fix yet
    const s = tracker.snapshot();
    assert.deepEqual(s.pad, { lat: 45.4642, lon: 9.19 });
    const { distance, bearing } = distanceBearing(s.pad, { lat: 45.4642, lon: 9.19 + 100 / (111320 * Math.cos(45.4642 * Math.PI / 180)) });
    assert.ok(Math.abs(distance - 100) < 0.5, `distance ${distance}`);
    assert.ok(Math.abs(bearing - 90) < 0.1, `bearing ${bearing}`);
});

test('the pad position stops moving at launch', () => {
    const tracker = new FlightTracker();
    tracker.update({ t: 0, kind: 'state', state: 'RS_IDLE' });
    tracker.update({ t: 1, kind: 'gps', lat: 45, lon: 9 });
    tracker.update({ t: 2, kind: 'state', state: 'RS_BOOST' });
    tracker.update({ t: 3, kind: 'gps', lat: 45.001, lon: 9.001 });
    const s = tracker.snapshot();
    assert.deepEqual(s.pad, { lat: 45, lon: 9 });
    assert.equal(s.track.length, 1);
});

test('lateral acceleration is across the long axis (IMU Z)', () => {
    assert.equal(lateral({ x: 300, y: -400, z: 8000 }), 500);
    const tracker = new FlightTracker();
    assert.equal(tracker.snapshot().lateralG, null);
    tracker.update({ t: 0, kind: 'accel', x: 300, y: -400, z: 8000 });
    near(tracker.snapshot().lateralG, 0.5, 1e-9, 'lateral');
    // Thrust along the axis alone is not lateral.
    tracker.update({ t: 1, kind: 'accel', x: 0, y: 0, z: 8000 });
    assert.equal(tracker.snapshot().lateralG, 0);
    assert.equal(tracker.snapshot().accelG, 8);
});

// --- two links ---------------------------------------------------------------

/**
 * Packets of one message type as the ground receives them, oldest first:
 * `ble` and `lora` are [rate in Hz, from s, until s] or null. LoRa arrives
 * `lag` s after the rocket sampled it.
 */
function received({ ble = null, lora = null, lag = 0.3, type = 'T_ALT_SPEED' } = {}) {
    const packets = [];
    for (const [link, span, delay] of [['ble', ble, 0], ['lora', lora, lag]]) {
        if (!span) continue;
        const [rate, from, until] = span;
        for (let i = Math.round(from * rate); i < until * rate; i++) {
            const t = (i / rate) * 1000;
            packets.push({ type, link, t, at: t + delay * 1000 });
        }
    }
    return packets.sort((a, b) => a.at - b.at);
}

const select = (packets, selector = new LinkSelector()) => packets.filter((p) => selector.accept(p.type, p.link, p.at));
const count = (packets, link) => packets.filter((p) => p.link === link).length;

test('two links up: only the preferred one is passed on', () => {
    const kept = select(received({ ble: [100, 0, 10], lora: [3, 0, 10] }));
    // LoRa's first packet can come before BLE's first; after that, none.
    assert.equal(count(kept, 'ble'), 1000);
    assert.ok(count(kept, 'lora') <= 1, `lora packets passed: ${count(kept, 'lora')}`);
});

test('the preferred link going quiet hands over to the other, and takes back', () => {
    const kept = select(received({ ble: [100, 0, 10], lora: [3, 0, 30] }).concat(received({ ble: [100, 20, 30] }))
        .sort((a, b) => a.at - b.at));
    const lora = kept.filter((p) => p.link === 'lora');
    // BLE's last packet is received at 9.99 s; LoRa's next ones follow within a second.
    near(lora[0].at, 10500, 500, 'first LoRa packet passed');
    assert.ok(lora.length >= 28, `LoRa packets across the 10 s gap: ${lora.length}`);
    assert.equal(lora.filter((p) => p.at >= 20000).length, 0, 'BLE takes the type back with its first packet');
    // What is passed on is in the rocket's time order across both handovers.
    assert.deepEqual(kept.map((p) => p.t), kept.map((p) => p.t).sort((a, b) => a - b));
});

test('a slow type on the preferred link still holds it', () => {
    // GPS: 2 Hz over BLE, with LoRa's copy in between.
    const kept = select(received({ ble: [2, 1, 20], lora: [3, 1, 20], type: 'T_GPS' }));
    assert.ok(count(kept, 'lora') <= 1, `lora packets passed: ${count(kept, 'lora')}`);
    assert.equal(count(kept, 'ble'), 38);
});

test('a single late packet from the preferred link barely interrupts the other', () => {
    const packets = received({ ble: [100, 0, 2], lora: [3, 0, 30] });
    packets.push({ type: 'T_ALT_SPEED', link: 'ble', t: 15000, at: 15000 });
    const kept = select(packets.sort((a, b) => a.at - b.at));
    const lost = received({ lora: [3, 15, 30] }).length - kept.filter((p) => p.link === 'lora' && p.at >= 15300).length;
    assert.ok(lost <= 2, `LoRa packets held back: ${lost}`);
});

test('links are chosen per message type', () => {
    const selector = new LinkSelector();
    // BLE delivers acceleration only; altitude comes over LoRa alone.
    const kept = select([
        ...received({ ble: [100, 0, 5], type: 'T_ACCELLERATION' }),
        ...received({ lora: [3, 0, 5], type: 'T_ALT_SPEED' })
    ].sort((a, b) => a.at - b.at), selector);
    assert.equal(count(kept, 'lora'), 15);
    assert.equal(count(kept, 'ble'), 500);
});

test('a link the preference does not name gives way to one it does', () => {
    const selector = new LinkSelector();
    assert.equal(selector.accept('T_GPS', 'other', 0), true);
    assert.equal(selector.accept('T_GPS', 'lora', 10), true);
    assert.equal(selector.accept('T_GPS', 'other', 20), false);
    assert.equal(selector.accept('T_GPS', 'lora', 30), true);
});

test('stored packets in the rocket\'s time order select the same way', () => {
    // History comes sorted by the rocket's timestamp, so LoRa's packets sit
    // before BLE packets that were received earlier.
    const packets = received({ ble: [100, 0, 10], lora: [3, 0, 20] }).sort((a, b) => a.t - b.t);
    const kept = select(packets);
    assert.ok(kept.filter((p) => p.link === 'lora' && p.t < 9500).length <= 1);
    assert.ok(kept.filter((p) => p.link === 'lora' && p.t >= 10500).length >= 28);
});

test('the tracker sees each sample once when both links carry the flight', () => {
    // The same flight over BLE alone, and over BLE plus a coarser, late LoRa copy.
    const flight = (links) => {
        const selector = new LinkSelector();
        const tracker = new FlightTracker();
        const samples = [];
        for (const [link, rate, lag, step] of links) {
            let state = null;
            for (let i = 0; i <= 90 * rate; i++) {
                const t = i / rate;
                const s = ideal(t);
                const at = (t + lag) * 1000;
                // LoRa's float16 altitude: steps of 2 m at these heights.
                const altitude = Math.round((PAD_ALT + s.h) / step) * step;
                if (s.state !== state || i % rate === 0) {
                    samples.push({ type: 'T_ROCKET_STATE', link, at, sample: { t: t * 1000, kind: 'state', state: s.state } });
                    state = s.state;
                }
                samples.push({ type: 'T_ALT_SPEED', link, at, sample: { t: t * 1000, kind: 'alt', altitude, speed: s.v } });
            }
        }
        samples.sort((a, b) => a.at - b.at);
        let fed = 0;
        for (const p of samples) {
            if (selector.accept(p.type, p.link, p.at) && tracker.update(p.sample)) {
                fed += p.type === 'T_ALT_SPEED' ? 1 : 0;
            }
        }
        return { snapshot: tracker.snapshot(), fed };
    };
    const one = flight([['ble', 50, 0, 0.01]]);
    const two = flight([['ble', 50, 0, 0.01], ['lora', 3, 0.3, 2]]);
    assert.equal(two.fed, one.fed);
    assert.deepEqual(two.snapshot, one.snapshot);
});

test('the flight is tracked from LoRa alone once BLE drops', () => {
    const selector = new LinkSelector();
    const tracker = new FlightTracker();
    const samples = [];
    // BLE until 21 s (just after ignition), LoRa throughout.
    for (const [link, rate, lag, until] of [['ble', 50, 0, 21], ['lora', 3, 0.3, 90]]) {
        let state = null;
        for (let i = 0; i <= until * rate; i++) {
            const t = i / rate;
            const s = ideal(t);
            const at = (t + lag) * 1000;
            if (s.state !== state || i % rate === 0) {
                samples.push({ type: 'T_ROCKET_STATE', link, at, sample: { t: t * 1000, kind: 'state', state: s.state } });
                state = s.state;
            }
            samples.push({ type: 'T_ALT_SPEED', link, at, sample: { t: t * 1000, kind: 'alt', altitude: PAD_ALT + s.h, speed: s.v } });
        }
    }
    samples.sort((a, b) => a.at - b.at);
    samples.forEach((p) => selector.accept(p.type, p.link, p.at) && tracker.update(p.sample));
    const s = tracker.snapshot();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN']);
    near(s.launchTime, 20000, 20, 'launch time');
    near(s.ground, PAD_ALT, 0.1, 'ground');
    near(s.apogee.agl, APOGEE, 3, 'apogee');
});
