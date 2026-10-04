/*
 * Flight tracking for the flight views.
 *
 * The rocket reports its flight state (T_ROCKET_STATE); the rest is derived
 * here: launch time and phase times from the state changes, ground level and
 * altitude above it from the barometer, apogee and other records, the pad
 * position from GPS. Also LinkSelector, which decides which link's packets
 * the tracker and every view get when two links carry the same quantity.
 * Pure logic, no DOM: runs in the browser (window.StarPiFlight) and under
 * `node --test`.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.StarPiFlight = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    const G = 9.80665;
    // The rocket's accelerometer reports milli-g.
    const MG_PER_G = 1000;

    // The rocket's own flight state (T_ROCKET_STATE, RocketState in the
    // firmware's logger.h), in wire order: the index is the enum's ordinal.
    const PHASES = ['IDLE', 'BOOST', 'COAST', 'DROGUE', 'MAIN', 'TOUCHDOWN'];
    const PHASE_LABELS = {
        IDLE: 'On pad',
        BOOST: 'Boost',
        COAST: 'Coast',
        DROGUE: 'Drogue',
        MAIN: 'Main',
        TOUCHDOWN: 'Touchdown'
    };
    const ON_GROUND = new Set([null, 'IDLE', 'TOUCHDOWN']);
    // Under a parachute: the first of these marks apogee.
    const DESCENDING = new Set(['DROGUE', 'MAIN']);

    const DEFAULTS = {
        groundWindow: 50, // Pad altitude samples in the ground-level median.
        padFixWindow: 20 // Pad GPS fixes averaged into the pad position.
    };

    // Links, best first, for the message types more than one of them carries:
    // BLE has every type at full rate, LoRa a few packets a second of some.
    const LINK_PREFERENCE = ['ble', 'lora'];
    // A link keeps a message type while that type keeps coming over it: for
    // three of its usual intervals, at least LINK_HOLD_MIN_MS (packets come in
    // bursts) and at most LINK_HOLD_MAX_MS (when the type goes stale anyway).
    const LINK_HOLD_INTERVALS = 3;
    const LINK_HOLD_MIN_MS = 500;
    const LINK_HOLD_MAX_MS = 5000;

    /**
     * One link per message type. With two links up the same quantity arrives
     * twice, the second copy later and at another rate, and passing both on
     * doubles every sample: plots zig-zag between them and the tracker's
     * medians and averages count the rocket twice.
     *
     * A packet is taken unless a better link (LINK_PREFERENCE) delivered the
     * same type a moment ago. So BLE feeds what it carries while it is heard,
     * LoRa takes each type over about half a second after BLE's last packet
     * of it, and hands it back with BLE's next one. A type only one link
     * carries always passes.
     *
     * `at` is when the ground station received the packet (received_at_us),
     * in ms: links are compared by what reached the ground, whatever the
     * rocket's clock says. The same rule serves the live stream and stored
     * packets, so a replay shows what was shown live.
     */
    class LinkSelector {
        constructor(preference = LINK_PREFERENCE) {
            this.preference = preference;
            this.types = new Map(); // message type -> Map<link, { seen, interval }>
        }

        /** Whether `a` is preferred to `b`; links not in the list come last, by name. */
        better(a, b) {
            const rank = (link) => {
                const index = this.preference.indexOf(link);

                return index < 0 ? this.preference.length : index;
            };

            return rank(a) !== rank(b) ? rank(a) < rank(b) : a < b;
        }

        accept(type, link, at) {
            if (!this.types.has(type)) {
                this.types.set(type, new Map());
            }
            const links = this.types.get(type);
            if (!links.has(link)) {
                links.set(link, { seen: -Infinity, interval: 0 });
            }
            const own = links.get(link);
            if (at > own.seen) {
                const gap = at - own.seen;
                // The usual interval: the last gap, or half the previous
                // estimate when packets of a burst arrive together. A long
                // silence says nothing about the rate.
                own.interval = gap > LINK_HOLD_MAX_MS ? 0 : Math.max(gap, own.interval / 2);
                own.seen = at;
            }

            for (const [other, { seen, interval }] of links) {
                const hold = Math.min(LINK_HOLD_MAX_MS, Math.max(LINK_HOLD_MIN_MS, LINK_HOLD_INTERVALS * interval));
                if (other !== link && this.better(other, link) && at - seen <= hold) {
                    return false;
                }
            }

            return true;
        }
    }

    /** A phase from a T_ROCKET_STATE payload ("RS_BOOST", or its ordinal), or null. */
    function phaseOf(payload) {
        if (typeof payload === 'string') {
            const name = payload.replace(/^RS_/, '');

            return PHASES.includes(name) ? name : null;
        }

        return PHASES[payload] ?? null;
    }

    function median(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);

        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function magnitude(vector) {
        return Math.hypot(vector.x || 0, vector.y || 0, vector.z || 0);
    }

    /** Magnitude across the rocket's long axis, which is the IMU's Z (see rocket/rocket-view.js). */
    function lateral(vector) {
        return Math.hypot(vector.x || 0, vector.y || 0);
    }

    /** Distance (m) and bearing (°, clockwise from north) between two fixes. */
    function distanceBearing(from, to) {
        const R = 6371000;
        const rad = Math.PI / 180;
        const lat1 = from.lat * rad;
        const lat2 = to.lat * rad;
        const dLat = lat2 - lat1;
        const dLon = (to.lon - from.lon) * rad;

        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        const distance = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        const bearing = (Math.atan2(y, x) / rad + 360) % 360;

        return { distance, bearing };
    }

    /** Local east/north offset (m) of `to` from `from`, fine over a few km. */
    function localOffset(from, to) {
        const rad = Math.PI / 180;
        const north = (to.lat - from.lat) * 111320;
        const east = (to.lon - from.lon) * 111320 * Math.cos(from.lat * rad);

        return { east, north };
    }

    /**
     * Feed samples in time order with `update()`; read the state with
     * `snapshot()`. Samples older than the last one of their kind are ignored,
     * so live data that overlaps a history request cannot rewind the state.
     * Kinds are not ordered against each other: one LoRa packet carries a
     * position sampled before its altitude.
     */
    class FlightTracker {
        constructor(options = {}) {
            this.config = { ...DEFAULTS, ...options };
            this.groundOverride = options.groundOverride ?? null;
            this.reset();
        }

        reset() {
            this.phase = null; // no T_ROCKET_STATE yet
            this.lastTime = -Infinity;
            this.lastOfKind = {};
            this.clearGroundSamples();
            this.padFixes = [];
            this.padPosition = null;
            this.frozenGround = null;
            this.newFlight();
            this.altitude = null;
            this.speed = null;
            this.accelG = null;
            this.lateralG = null;
            this.fix = null;
        }

        newFlight() {
            this.launchTime = null;
            this.events = [];
            this.apogee = null;
            this.maxAgl = null;
            this.maxSpeed = 0;
            this.maxAccelG = 0;
            this.track = [];
        }

        clearGroundSamples() {
            this.groundSamples = [];
            this.groundMedian = undefined;
        }

        /**
         * Median of the pad altitude samples, or null. Cached until the next
         * sample: `ground` and `agl` are read several times per sample.
         */
        padMedian() {
            if (this.groundMedian === undefined) {
                this.groundMedian = this.groundSamples.length ? median(this.groundSamples) : null;
            }

            return this.groundMedian;
        }

        /** Pin the ground level (m); `null` goes back to the pad median. */
        setGround(altitude) {
            this.groundOverride = altitude;
        }

        get ground() {
            if (this.groundOverride !== null && this.groundOverride !== undefined) {
                return this.groundOverride;
            }
            if (this.frozenGround !== null) {
                return this.frozenGround;
            }

            return this.padMedian();
        }

        get agl() {
            const ground = this.ground;

            return this.altitude === null || ground === null ? null : this.altitude - ground;
        }

        /**
         * @param {object} sample  one of
         *   { t, kind: 'alt', altitude, speed }
         *   { t, kind: 'accel', x, y, z }       mg
         *   { t, kind: 'gps', lat, lon }
         *   { t, kind: 'state', state }         T_ROCKET_STATE payload
         */
        update(sample) {
            if (!(sample.t >= (this.lastOfKind[sample.kind] ?? -Infinity))) {
                return false;
            }
            this.lastOfKind[sample.kind] = sample.t;
            this.lastTime = Math.max(this.lastTime, sample.t);

            if (sample.kind === 'alt') {
                this.onAltitude(sample);
            } else if (sample.kind === 'accel') {
                this.onAccel(sample);
            } else if (sample.kind === 'gps') {
                this.onFix(sample);
            } else if (sample.kind === 'state') {
                this.onState(sample);
            }

            return true;
        }

        onAltitude({ t, altitude, speed }) {
            if (!Number.isFinite(altitude)) {
                return;
            }
            this.altitude = altitude;
            this.speed = Number.isFinite(speed) ? speed : this.speed;

            if (this.onGround()) {
                this.groundSamples.push(altitude);
                if (this.groundSamples.length > this.config.groundWindow) {
                    this.groundSamples.shift();
                }
                this.groundMedian = undefined;
            } else {
                this.trackRecords(t);
            }
        }

        onAccel({ x, y, z }) {
            const g = magnitude({ x, y, z }) / MG_PER_G;
            this.accelG = g;
            this.lateralG = lateral({ x, y }) / MG_PER_G;
            if (!this.onGround()) {
                this.maxAccelG = Math.max(this.maxAccelG, g);
            }
        }

        onFix({ t, lat, lon }) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
                return;
            }
            this.fix = { t, lat, lon };

            if (this.phase === null || this.phase === 'IDLE') {
                this.padFixes.push({ lat, lon });
                if (this.padFixes.length > this.config.padFixWindow) {
                    this.padFixes.shift();
                }
                this.padPosition = {
                    lat: this.padFixes.reduce((sum, f) => sum + f.lat, 0) / this.padFixes.length,
                    lon: this.padFixes.reduce((sum, f) => sum + f.lon, 0) / this.padFixes.length
                };
            } else if (this.padPosition === null) {
                // First fix arrived after launch: the best pad guess there is.
                this.padPosition = { lat, lon };
            }

            if (this.launchTime !== null) {
                this.track.push({ t, lat, lon });
            }
        }

        onState({ t, state }) {
            const phase = phaseOf(state);
            const previous = this.phase;
            if (phase === null || phase === previous) {
                return;
            }
            this.phase = phase;

            if (previous === 'TOUCHDOWN') {
                // Back on a pad (or straight into another flight): start over,
                // with the ground measured since touchdown.
                this.newFlight();
                this.newPad();
                this.frozenGround = null;
            }
            if (phase === 'IDLE') {
                return;
            }
            // A state can be missed (a lost packet): leaving the ground at all is the launch.
            if (ON_GROUND.has(previous) && previous !== null && !ON_GROUND.has(phase)) {
                this.launch(t);
            } else if (previous === null && !ON_GROUND.has(phase)) {
                // First state seen mid-flight: the altitudes so far were not
                // the ground, and the launch time is unknown.
                this.clearGroundSamples();
            }
            if (DESCENDING.has(phase) && !DESCENDING.has(previous) && this.apogee === null && this.maxAgl !== null) {
                this.apogee = { agl: this.maxAgl, t: this.maxAglTime };
            }
            if (phase === 'TOUCHDOWN') {
                // Keep the pad's ground level on screen; samples from here on
                // set the ground for the next launch.
                this.clearGroundSamples();
            }
            this.events.push({ phase, t });
        }

        newPad() {
            this.padFixes = [];
            this.padPosition = this.fix ? { lat: this.fix.lat, lon: this.fix.lon } : null;
        }

        onGround() {
            return ON_GROUND.has(this.phase);
        }

        launch(t) {
            this.frozenGround = this.padMedian() ?? this.altitude;
            this.launchTime = t;
        }

        trackRecords(t) {
            const agl = this.agl;
            if (agl !== null && (this.maxAgl === null || agl > this.maxAgl)) {
                this.maxAgl = agl;
                this.maxAglTime = t;
            }
            if (this.speed !== null) {
                this.maxSpeed = Math.max(this.maxSpeed, this.speed);
            }
        }

        snapshot() {
            const pad = this.padPosition;
            const fix = this.fix;

            return {
                phase: this.phase,
                ground: this.ground,
                groundPinned: this.groundOverride !== null && this.groundOverride !== undefined,
                altitude: this.altitude,
                agl: this.agl,
                speed: this.speed,
                accelG: this.accelG,
                lateralG: this.lateralG,
                launchTime: this.launchTime,
                apogee: this.apogee,
                maxAgl: this.maxAgl,
                maxSpeed: this.maxSpeed,
                maxAccelG: this.maxAccelG,
                events: [...this.events],
                pad,
                fix,
                fromPad: pad && fix ? distanceBearing(pad, fix) : null,
                track: this.track
            };
        }
    }

    return {
        G,
        MG_PER_G,
        PHASES,
        PHASE_LABELS,
        phaseOf,
        DEFAULTS,
        FlightTracker,
        LINK_PREFERENCE,
        LinkSelector,
        distanceBearing,
        localOffset,
        magnitude,
        lateral,
        median
    };
}));
