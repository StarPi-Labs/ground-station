const test = require('node:test');
const assert = require('node:assert/strict');
const { FlightTracker, distanceBearing, G } = require('./flight-state.js');

// A flight like the backend simulator's: 20 s on the pad, 2.2 s burn at 4 g,
// coast to ~285 m, 8 m/s under the parachute, then on the ground.
const PAD_ALT = 120;
const BURN_S = 2.2;
const BURN = 4 * G;
const V0 = (BURN - G) * BURN_S;
const H0 = 0.5 * (BURN - G) * BURN_S ** 2;
const APOGEE_T = 20 + BURN_S + V0 / G;
const APOGEE = H0 + V0 ** 2 / (2 * G);

function ideal(t) {
    if (t < 20) return { h: 0, v: 0, a: G };
    if (t < 20 + BURN_S) {
        const dt = t - 20;
        return { h: 0.5 * (BURN - G) * dt ** 2, v: (BURN - G) * dt, a: BURN };
    }
    if (t < APOGEE_T) {
        const dt = t - 20 - BURN_S;
        return { h: H0 + V0 * dt - 0.5 * G * dt ** 2, v: V0 - G * dt, a: 0.4 };
    }
    const h = APOGEE - 8 * (t - APOGEE_T);
    return h > 0 ? { h, v: -8, a: G } : { h: 0, v: 0, a: G };
}

// Deterministic noise, so a failing run can be reproduced.
function rng(seed) {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648 - 0.5;
    };
}

function fly({ rate = 5, noise = 0, until = 90, gap = null } = {}) {
    const tracker = new FlightTracker();
    const random = rng(42);
    for (let i = 0; i <= until * rate; i++) {
        const t = i / rate;
        if (gap && t >= gap[0] && t < gap[1]) continue;
        const s = ideal(t);
        const ms = t * 1000;
        tracker.update({ t: ms, kind: 'accel', x: 0, y: 0, z: s.a + noise * 1.2 * random() });
        tracker.update({ t: ms, kind: 'alt', altitude: PAD_ALT + s.h + noise * random(), speed: s.v + noise * random() });
    }
    return tracker.snapshot();
}

const phases = (snapshot) => snapshot.events.map((e) => e.phase);

test('clean flight goes through every phase in order', () => {
    const s = fly();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'APOGEE', 'DESCENT', 'LANDED']);
    assert.equal(s.phase, 'LANDED');
    assert.ok(Math.abs(s.launchTime - 20000) <= 200, `launch at ${s.launchTime}`);
    assert.ok(Math.abs(s.apogee.agl - APOGEE) < 2, `apogee ${s.apogee.agl} vs ${APOGEE}`);
    assert.ok(Math.abs(s.apogee.t - APOGEE_T * 1000) <= 200);
    assert.ok(s.maxAccelG > 3.9 && s.maxAccelG < 4.1);
    assert.ok(Math.abs(s.ground - PAD_ALT) < 0.01);
});

test('altitude above ground stays defined through landing', () => {
    const tracker = new FlightTracker();
    for (let t = 0; t <= 90; t += 0.2) {
        const s = ideal(t);
        tracker.update({ t: t * 1000, kind: 'alt', altitude: PAD_ALT + s.h, speed: s.v });
        if (tracker.snapshot().phase === 'LANDED') {
            assert.ok(Math.abs(tracker.snapshot().agl) < 0.5, `agl ${tracker.snapshot().agl} at landing`);
            return;
        }
    }
    assert.fail('never landed');
});

test('noisy flight: no false phases, apogee within a few metres', () => {
    const s = fly({ noise: 0.8 });
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'APOGEE', 'DESCENT', 'LANDED']);
    assert.ok(Math.abs(s.apogee.agl - APOGEE) < 3, `apogee ${s.apogee.agl}`);
    assert.ok(Math.abs(s.ground - PAD_ALT) < 0.5, `ground ${s.ground}`);
});

test('pad noise alone never triggers a launch', () => {
    const tracker = new FlightTracker();
    const random = rng(7);
    for (let t = 0; t < 60000; t += 200) {
        tracker.update({ t, kind: 'accel', x: random(), y: random(), z: G + 3 * random() });
        tracker.update({ t, kind: 'alt', altitude: PAD_ALT + random(), speed: 2 * random() });
    }
    assert.equal(tracker.snapshot().phase, 'PAD');
});

test('a telemetry gap across the burn still finds launch and apogee', () => {
    // Data resumes mid-coast: launch is dated to the first sample back.
    const s = fly({ gap: [19.8, 23] });
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'APOGEE', 'DESCENT', 'LANDED']);
    assert.equal(s.launchTime, 23000);
    assert.ok(Math.abs(s.apogee.agl - APOGEE) < 2);
});

test('altitude-only data (no accelerometer) still detects the flight', () => {
    const tracker = new FlightTracker();
    for (let t = 0; t <= 90; t += 0.2) {
        const s = ideal(t);
        tracker.update({ t: t * 1000, kind: 'alt', altitude: PAD_ALT + s.h, speed: s.v });
    }
    const s = tracker.snapshot();
    assert.equal(s.phase, 'LANDED');
    assert.ok(Math.abs(s.apogee.agl - APOGEE) < 2);
});

test('a second flight after landing resets the records', () => {
    const tracker = new FlightTracker();
    for (const offset of [0, 90]) {
        for (let t = 0; t < 90; t += 0.2) {
            const s = ideal(t);
            const ms = (offset + t) * 1000;
            tracker.update({ t: ms, kind: 'accel', x: 0, y: 0, z: s.a });
            tracker.update({ t: ms, kind: 'alt', altitude: PAD_ALT + s.h, speed: s.v });
        }
    }
    const s = tracker.snapshot();
    assert.deepEqual(phases(s), ['BOOST', 'COAST', 'APOGEE', 'DESCENT', 'LANDED']);
    assert.ok(Math.abs(s.launchTime - 110000) <= 200);
});

test('samples older than the last one are ignored', () => {
    const tracker = new FlightTracker();
    assert.equal(tracker.update({ t: 1000, kind: 'alt', altitude: 100, speed: 0 }), true);
    assert.equal(tracker.update({ t: 500, kind: 'alt', altitude: 999, speed: 0 }), false);
    assert.equal(tracker.snapshot().altitude, 100);
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
