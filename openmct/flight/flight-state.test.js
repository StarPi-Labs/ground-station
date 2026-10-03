const test = require('node:test');
const assert = require('node:assert/strict');
const { FlightTracker, distanceBearing, phaseOf, G, MG_PER_G } = require('./flight-state.js');

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
