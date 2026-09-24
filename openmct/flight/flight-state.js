/*
 * Flight phase estimation for the Launch Control view.
 *
 * The rocket does not report its flight state, ground altitude or apogee, so
 * they are inferred here from barometric altitude/speed and the accelerometer.
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

    const PHASES = ['PAD', 'BOOST', 'COAST', 'APOGEE', 'DESCENT', 'LANDED'];

    const DEFAULTS = {
        launchAccelG: 2.0, // PAD -> BOOST when the accelerometer reads more than this...
        launchHoldMs: 200, // ...for at least this long,
        launchSpeed: 15, // or the vertical speed exceeds this (m/s).
        burnoutAccelG: 1.2, // BOOST -> COAST below this.
        apogeeHoldMs: 2000, // How long APOGEE stays on screen before DESCENT.
        apogeeDropM: 5, // Fallback apogee trigger: this far below the peak.
        apogeeArmMs: 1000, // No apogee this soon after launch (baro lag at liftoff).
        landedSpeed: 1, // DESCENT -> LANDED when |speed| stays below this (m/s)
        landedAgl: 15, // and the altitude above ground stays below this (m)
        landedHoldMs: 5000, // for this long.
        groundWindow: 50, // Pad altitude samples in the ground-level median.
        padFixWindow: 20 // Pad GPS fixes averaged into the pad position.
    };

    function median(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);

        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function magnitude(vector) {
        return Math.hypot(vector.x || 0, vector.y || 0, vector.z || 0);
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
     * Feed samples in time order with `update()`; read the estimate with
     * `snapshot()`. Samples older than the last one seen are ignored, so live
     * data that overlaps a history request cannot rewind the state.
     */
    class FlightTracker {
        constructor(options = {}) {
            this.config = { ...DEFAULTS, ...options };
            this.groundOverride = options.groundOverride ?? null;
            this.reset();
        }

        reset() {
            this.phase = 'PAD';
            this.lastTime = -Infinity;
            this.groundSamples = [];
            this.padFixes = [];
            this.padPosition = null;
            this.frozenGround = null;
            this.newFlight();
            this.altitude = null;
            this.speed = null;
            this.accelG = null;
            this.fix = null;
        }

        newFlight() {
            this.launchTime = null;
            this.events = [];
            this.apogee = null;
            this.maxAgl = null;
            this.maxSpeed = 0;
            this.maxAccelG = 0;
            this.highAccelSince = null;
            this.landedSince = null;
            this.track = [];
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

            return this.groundSamples.length ? median(this.groundSamples) : null;
        }

        get agl() {
            const ground = this.ground;

            return this.altitude === null || ground === null ? null : this.altitude - ground;
        }

        /**
         * @param {object} sample  one of
         *   { t, kind: 'alt', altitude, speed }
         *   { t, kind: 'accel', x, y, z }       m/s²
         *   { t, kind: 'gps', lat, lon }
         */
        update(sample) {
            if (!(sample.t >= this.lastTime)) {
                return false;
            }
            this.lastTime = sample.t;

            if (sample.kind === 'alt') {
                this.onAltitude(sample);
            } else if (sample.kind === 'accel') {
                this.onAccel(sample);
            } else if (sample.kind === 'gps') {
                this.onFix(sample);
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
            }

            if (this.onGround() && this.speed > this.config.launchSpeed) {
                this.launch(t);
            }

            if (!this.onGround()) {
                this.trackRecords(t);
                this.advance(t);
            }
        }

        onAccel({ t, x, y, z }) {
            const g = magnitude({ x, y, z }) / G;
            this.accelG = g;

            if (this.onGround()) {
                if (g > this.config.launchAccelG) {
                    this.highAccelSince ??= t;
                    if (t - this.highAccelSince >= this.config.launchHoldMs) {
                        this.launch(this.highAccelSince);
                    }
                } else {
                    this.highAccelSince = null;
                }

                return;
            }

            this.maxAccelG = Math.max(this.maxAccelG, g);
            if (this.phase === 'BOOST' && g < this.config.burnoutAccelG) {
                this.enter('COAST', t);
            }
        }

        onFix({ t, lat, lon }) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
                return;
            }
            this.fix = { t, lat, lon };

            if (this.phase === 'PAD') {
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

        onGround() {
            return this.phase === 'PAD' || this.phase === 'LANDED';
        }

        launch(t) {
            if (this.phase === 'LANDED') {
                // Another flight after landing (or the simulator looping).
                this.newFlight();
                this.padFixes = [];
                if (this.fix) {
                    this.padPosition = { lat: this.fix.lat, lon: this.fix.lon };
                }
            }
            this.frozenGround = this.groundSamples.length ? median(this.groundSamples) : this.altitude;
            this.launchTime = t;
            this.highAccelSince = null;
            this.enter('BOOST', t);
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

        advance(t) {
            const speed = this.speed ?? 0;
            const agl = this.agl ?? 0;
            const cfg = this.config;

            const armed = t - this.launchTime >= cfg.apogeeArmMs;
            if (armed && (this.phase === 'BOOST' || this.phase === 'COAST')) {
                const falling = speed <= 0 || (this.maxAgl !== null && agl < this.maxAgl - cfg.apogeeDropM);
                if (falling) {
                    this.apogee = { agl: this.maxAgl, t: this.maxAglTime };
                    this.enter('APOGEE', this.maxAglTime ?? t);
                }
            } else if (this.phase === 'APOGEE') {
                if (t - this.apogee.t >= cfg.apogeeHoldMs) {
                    this.enter('DESCENT', t);
                }
            }

            if (this.phase === 'DESCENT' || this.phase === 'APOGEE') {
                if (Math.abs(speed) < cfg.landedSpeed && agl < cfg.landedAgl) {
                    this.landedSince ??= t;
                    if (t - this.landedSince >= cfg.landedHoldMs) {
                        this.enter('LANDED', this.landedSince);
                        // Keep the pad's ground level on screen; samples from
                        // here on set the ground for the next launch.
                        this.groundSamples = [];
                    }
                } else {
                    this.landedSince = null;
                }
            }
        }

        enter(phase, t) {
            if (phase === this.phase) {
                return;
            }
            this.phase = phase;
            this.events.push({ phase, t });
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
        PHASES,
        DEFAULTS,
        FlightTracker,
        distanceBearing,
        localOffset,
        magnitude,
        median
    };
}));
