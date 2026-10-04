/*
 * Flight telemetry as Open MCT objects: the rocket's reported phase, and what
 * is derived around it - mission time, altitude above ground, records,
 * distance from the pad... (see flightPoints). They behave like any other
 * telemetry object, so plots, LAD tables, gauges and condition sets can use
 * them.
 *
 * Live values come from one FlightTracker (flight-state.js) fed by the
 * websocket, primed with the last LOOKBACK_MS of history so a page opened
 * mid-flight knows the launch time and the ground level. History for a time
 * window is computed by replaying the stored packets through a fresh tracker.
 *
 * A ground level set in the "Flight settings" object (FlightSettings type
 * below, edited with Edit Properties) replaces the pad median.
 */
(function () {
    const TYPE = 'starpi.flight';
    const SETTINGS_TYPE = 'starpi.flight-settings';
    const SETTINGS_ID = { namespace: '', key: 'starpi-flight-settings' };
    // History fed to a tracker before the window it reports on: long enough
    // to find the pad's ground level and the launch of a flight in progress.
    const LOOKBACK_MS = 10 * 60 * 1000;
    const SOURCES = { alt: 'T_ALT_SPEED', accel: 'T_ACCELLERATION', gps: 'T_GPS', state: 'T_ROCKET_STATE' };
    // What the flight objects go stale with, unless a point names its own source.
    const STALE_SOURCE = 'T_ALT_SPEED';

    function flightPoints() {
        const { PHASES } = window.StarPiFlight;
        const launched = (tracker) => tracker.launchTime !== null;

        return {
            'flight.phase': {
                name: 'Flight phase',
                format: 'enum',
                // The values are RocketState's ordinals, as the rocket sends them.
                enumerations: PHASES.map((phase, index) => ({ value: index, string: phase })),
                on: ['state'],
                stale: 'T_ROCKET_STATE',
                value: (tracker) => (tracker.phase === null ? null : PHASES.indexOf(tracker.phase))
            },
            'flight.mission-time': {
                name: 'Mission time',
                format: 'starpi.mission-time',
                on: ['alt', 'accel', 'state'],
                value: (tracker, t) => {
                    if (!launched(tracker)) {
                        return null;
                    }
                    const landed = tracker.events.find((event) => event.phase === 'TOUCHDOWN');

                    return ((landed ? landed.t : t) - tracker.launchTime) / 1000;
                }
            },
            'flight.agl': { name: 'Altitude above ground', precision: 1, unit: 'm', on: ['alt'], value: (tracker) => tracker.agl },
            'flight.accel': { name: 'Acceleration (total)', precision: 2, unit: 'g', on: ['accel'], value: (tracker) => tracker.accelG },
            'flight.lateral-accel': {
                name: 'Acceleration (lateral)',
                precision: 2,
                unit: 'g',
                on: ['accel'],
                value: (tracker) => tracker.lateralG
            },
            'flight.apogee': {
                name: 'Apogee',
                precision: 1,
                unit: 'm',
                on: ['alt'],
                value: (tracker) => (tracker.apogee ? tracker.apogee.agl : launched(tracker) ? tracker.maxAgl : null)
            },
            'flight.max-speed': {
                name: 'Max vertical speed',
                precision: 1,
                unit: 'm/s',
                on: ['alt'],
                value: (tracker) => (launched(tracker) ? tracker.maxSpeed : null)
            },
            'flight.max-accel': {
                name: 'Max acceleration',
                precision: 2,
                unit: 'g',
                on: ['accel'],
                value: (tracker) => (launched(tracker) ? tracker.maxAccelG : null)
            },
            'flight.ground': { name: 'Ground level (MSL)', precision: 1, unit: 'm', on: ['alt'], value: (tracker) => tracker.ground },
            'flight.distance': {
                name: 'Distance from pad',
                precision: 0,
                unit: 'm',
                on: ['gps'],
                value: (tracker) => fromPad(tracker)?.distance
            },
            'flight.bearing': {
                name: 'Bearing from pad',
                precision: 0,
                unit: '°',
                on: ['gps'],
                value: (tracker) => fromPad(tracker)?.bearing
            },
            'flight.track': {
                name: 'Ground track',
                on: ['gps'],
                // Two ranges, for a scatter plot of the path seen from above.
                values: [
                    { key: 'east', name: 'East of pad', unit: 'm', format: 'float', formatString: '%0.1f', hints: { range: 1 } },
                    { key: 'north', name: 'North of pad', unit: 'm', format: 'float', formatString: '%0.1f', hints: { range: 2 } }
                ],
                datum: (tracker, t) => {
                    if (!tracker.padPosition || !tracker.fix) {
                        return null;
                    }
                    const { east, north } = window.StarPiFlight.localOffset(tracker.padPosition, tracker.fix);

                    return { utc: t, east, north };
                }
            }
        };
    }

    function fromPad(tracker) {
        if (!tracker.padPosition || !tracker.fix) {
            return null;
        }

        return window.StarPiFlight.distanceBearing(tracker.padPosition, tracker.fix);
    }

    function datumFor(point, tracker, t) {
        if (point.datum) {
            return point.datum(tracker, t);
        }
        const value = point.value(tracker, t);

        return value === null || value === undefined || Number.isNaN(value) ? null : { utc: t, value };
    }

    /**
     * Open MCT's 'minmax' for computed rows ({ utc, value }, oldest first): the
     * range cut into size / 2 buckets, each keeping its lowest and highest
     * value, so peaks survive. Mirrors GET /api/packets/minmax.
     */
    function minmax(rows, start, end, size) {
        if (rows.length <= size) {
            return rows;
        }
        const width = Math.max(1, (end - start) / Math.max(1, Math.floor(size / 2)));
        const out = [];
        let bucket = null;
        let low = null;
        let high = null;
        const close = () => {
            if (!low) {
                return;
            }
            out.push(...(low === high ? [low] : low.utc <= high.utc ? [low, high] : [high, low]));
        };
        for (const row of rows) {
            const b = Math.floor((row.utc - start) / width);
            if (b !== bucket) {
                close();
                bucket = b;
                low = row;
                high = row;
            } else if (row.value < low.value) {
                low = row;
            } else if (row.value > high.value) {
                high = row;
            }
        }
        close();

        return out;
    }

    /** Tracker input from a backend packet. */
    function sample(kind, packet) {
        const t = Math.floor(packet.timestamp_us / 1000);
        const p = packet.payload || {};
        if (kind === 'alt') {
            return { t, kind, altitude: p.x, speed: p.y };
        }
        if (kind === 'accel') {
            return { t, kind, x: p.x, y: p.y, z: p.z };
        }
        if (kind === 'state') {
            return { t, kind, state: packet.payload };
        }

        return { t, kind, lat: p.x, lon: p.y };
    }

    function numberOrNull(value) {
        if (value === '' || value === null || value === undefined) {
            return null;
        }
        const number = Number(value);

        return Number.isFinite(number) ? number : null;
    }

    class FlightService {
        constructor(openmct) {
            this.openmct = openmct;
            this.type = TYPE;
            this.points = flightPoints();
            // Point keys by the sample kind that updates them: looked up for every sample.
            this.pointsOn = Object.fromEntries(Object.keys(SOURCES).map((kind) => [kind, []]));
            for (const [key, point] of Object.entries(this.points)) {
                point.on.forEach((kind) => this.pointsOn[kind].push(key));
            }
            this.listeners = new Map(); // point key -> Set<callback>
            this.settingsListeners = new Set();
            this.settings = {};
            this.replays = new Map();
            this.generation = 0;
        }

        metadata(key) {
            const point = this.points[key];
            const domain = { key: 'utc', source: 'utc', name: 'Timestamp', format: 'utc', hints: { domain: 1 } };
            if (point.values) {
                return [domain, ...point.values];
            }
            const value = { key: 'value', name: point.name, format: point.format || 'float', hints: { range: 1 } };
            if (point.unit) {
                value.unit = point.unit;
            }
            if (point.enumerations) {
                value.enumerations = point.enumerations;
            }
            if (point.precision !== undefined) {
                value.formatString = `%0.${point.precision}f`;
            }

            return [domain, value];
        }

        /** The message type a point goes stale with. */
        staleSource(key) {
            return this.points[key]?.stale ?? STALE_SOURCE;
        }

        /** FlightTracker options from the current settings. */
        options() {
            return { groundOverride: numberOrNull(this.settings.groundAltitude) };
        }

        onSettings(callback) {
            this.settingsListeners.add(callback);

            return () => this.settingsListeners.delete(callback);
        }

        // --- live ------------------------------------------------------------------

        start() {
            for (const [kind, type] of Object.entries(SOURCES)) {
                window.StarPi.stream.subscribe(type, (packet) => this.onPacket(kind, packet));
            }
            this.restart();
            // The tracker only takes time going forward: start over when the
            // rocket clock jumps (a restart of the rocket). While priming, the
            // restart under way already waits for the clock.
            window.StarPi.clock.onJump(() => {
                if (!this.priming) {
                    this.restart();
                }
            });
            this.openmct.types.addType(SETTINGS_TYPE, settingsType());
            this.openmct.objectViews.addProvider(settingsView(this.openmct));
            // watchSettings() runs once the dashboard seed has created the object.
        }

        /** New tracker primed with recent history; live packets queue meanwhile. */
        async restart() {
            const generation = ++this.generation;
            this.tracker = new window.StarPiFlight.FlightTracker(this.options());
            this.queue = [];
            this.priming = true;
            this.replays.clear();

            // History up to the rocket's time now, once the backend has told it.
            const { clock } = window.StarPi;
            await clock.ready;
            if (generation !== this.generation) {
                return;
            }
            const now = clock.currentValue();
            let samples = [];
            try {
                samples = await this.history(now - LOOKBACK_MS, now);
            } catch (error) {
                console.warn('StarPi: could not prime the flight state', error);
            }
            if (generation !== this.generation) {
                return;
            }
            samples.forEach((s) => this.tracker.update(s));
            this.priming = false;
            const queued = this.queue;
            this.queue = [];
            queued.forEach((s) => this.feed(s));
            this.emitAll();
        }

        onPacket(kind, packet) {
            const s = sample(kind, packet);
            if (this.priming) {
                this.queue.push(s);
            } else {
                this.feed(s);
            }
        }

        feed(s) {
            if (!this.tracker.update(s)) {
                return;
            }
            for (const key of this.pointsOn[s.kind]) {
                const callbacks = this.listeners.get(key);
                if (!callbacks?.size) {
                    continue;
                }
                const datum = datumFor(this.points[key], this.tracker, s.t);
                if (datum) {
                    callbacks.forEach((callback) => callback(datum));
                }
            }
        }

        emitAll() {
            const t = this.tracker.lastTime;
            if (!Number.isFinite(t)) {
                return;
            }
            for (const [key, callbacks] of this.listeners) {
                const datum = datumFor(this.points[key], this.tracker, t);
                if (datum) {
                    callbacks.forEach((callback) => callback(datum));
                }
            }
        }

        subscribe(key, callback) {
            if (!this.listeners.has(key)) {
                this.listeners.set(key, new Set());
            }
            this.listeners.get(key).add(callback);

            return () => this.listeners.get(key).delete(callback);
        }

        // --- history -----------------------------------------------------------------

        async history(start, end) {
            const kinds = Object.keys(SOURCES);
            const packets = await Promise.all(kinds.map((kind) => window.StarPi.fetchRange(SOURCES[kind], start, end)));
            const samples = [];
            kinds.forEach((kind, index) => packets[index].forEach((packet) => samples.push(sample(kind, packet))));

            return samples.sort((a, b) => a.t - b.t);
        }

        /** Every point's datums for [start, end]; shared by the concurrent requests of one view. */
        replay(start, end) {
            const key = `${start}|${end}`;
            if (!this.replays.has(key)) {
                const run = this.history(start - LOOKBACK_MS, end).then((samples) => {
                    const tracker = new window.StarPiFlight.FlightTracker(this.options());
                    const rows = Object.fromEntries(Object.keys(this.points).map((k) => [k, []]));
                    for (const s of samples) {
                        if (!tracker.update(s) || s.t < start) {
                            continue;
                        }
                        for (const k of this.pointsOn[s.kind]) {
                            const datum = datumFor(this.points[k], tracker, s.t);
                            if (datum) {
                                rows[k].push(datum);
                            }
                        }
                    }

                    return rows;
                });
                this.replays.set(key, run);
                // Keep the result briefly: every view on a layout asks at once.
                run.finally(() => setTimeout(() => this.replays.delete(key), 5000));
            }

            return this.replays.get(key);
        }

        async request(key, options) {
            const end = options.end ?? this.openmct.time.now();
            const start = options.start ?? end - LOOKBACK_MS;
            const rows = (await this.replay(start, end))[key];
            if (options.strategy === 'latest') {
                return rows.slice(-1);
            }
            // Plots ask for 'minmax': the replay yields a row per 100 Hz sample.
            if (options.strategy === 'minmax' && options.size > 0 && !this.points[key].datum) {
                return minmax(rows, start, end, options.size);
            }

            return rows;
        }

        // --- settings ------------------------------------------------------------------

        /** Follow the Flight settings object, once it exists (dashboard/seed.js creates it). */
        async watchSettings() {
            if (this.unobserve) {
                return;
            }
            let settings;
            try {
                settings = await this.openmct.objects.get(SETTINGS_ID);
            } catch (error) {
                return;
            }
            if (!settings || settings.type !== SETTINGS_TYPE) {
                return;
            }
            this.applySettings(settings.configuration);
            this.unobserve = this.openmct.objects.observe(settings, 'configuration', (configuration) => {
                this.applySettings(configuration);
            });
        }

        applySettings(configuration = {}) {
            // Compare what the tracker would run with, not the raw form: the
            // settings object can hold other keys (the phase thresholds of
            // older versions), and restarting re-fetches minutes of history.
            const effective = () => JSON.stringify(this.options());
            const before = effective();
            this.settings = { ...configuration };
            if (effective() === before) {
                return;
            }
            this.restart();
            this.settingsListeners.forEach((callback) => callback(this.options()));
        }
    }

    const GROUND_FIELD = 'Ground level override (m MSL, empty = pad median)';

    function settingsType() {
        return {
            name: 'Flight Settings',
            description: 'Ground level the dashboard measures altitude above ground from.',
            cssClass: 'icon-gear',
            creatable: false,
            initialize(domainObject) {
                domainObject.configuration = { groundAltitude: '' };
            },
            form: [
                {
                    key: 'groundAltitude',
                    name: GROUND_FIELD,
                    control: 'textfield',
                    cssClass: 'l-input-sm',
                    property: ['configuration', 'groundAltitude']
                }
            ]
        };
    }

    /** Read-only summary of the settings; they are edited with Edit Properties. */
    function settingsView(openmct) {
        const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

        return {
            key: 'starpi.flight-settings-view',
            name: 'Flight Settings',
            cssClass: 'icon-gear',
            canView: (domainObject) => domainObject.type === SETTINGS_TYPE,
            view(domainObject) {
                let unobserve;
                const render = (element, configuration = {}) => {
                    const ground = configuration.groundAltitude === '' || configuration.groundAltitude === undefined
                        ? 'pad median'
                        : `${escape(configuration.groundAltitude)} m MSL`;
                    element.innerHTML = `
                        <div style="padding: 12px 16px; overflow: auto; height: 100%;">
                            <p style="margin: 0 0 12px;">The flight phase comes from the rocket. Altitude above ground
                                is measured from the median altitude on the pad, or from a ground level set here with
                                <strong>Edit Properties</strong> (the ⋯ menu); every flight view picks it up at once.</p>
                            <table class="c-table c-table--sortable" style="width: auto;">
                                <thead><tr><th>Setting</th><th>Value</th></tr></thead>
                                <tbody><tr><td>Ground level</td><td>${ground}</td></tr></tbody>
                            </table>
                        </div>`;
                };

                return {
                    show(element) {
                        render(element, domainObject.configuration);
                        unobserve = openmct.objects.observe(domainObject, 'configuration', (configuration) => {
                            render(element, configuration);
                        });
                    },
                    destroy() {
                        unobserve?.();
                    }
                };
            }
        };
    }

    FlightService.SETTINGS_ID = SETTINGS_ID;
    FlightService.SETTINGS_TYPE = SETTINGS_TYPE;
    window.StarPiFlightService = FlightService;
}());
