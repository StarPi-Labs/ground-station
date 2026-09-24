/*
 * Flight estimates as Open MCT telemetry: phase, mission time, altitude above
 * ground, records, distance from the pad... (see POINTS). They behave like any
 * other telemetry object, so plots, LAD tables, gauges and condition sets can
 * use them.
 *
 * Live values come from one FlightTracker (flight-state.js) fed by the
 * websocket, primed with the last LOOKBACK_MS of history so a page opened
 * mid-flight knows the phase and the ground level. History for a time window
 * is computed by replaying the stored packets through a fresh tracker.
 *
 * The thresholds come from the "Flight settings" object (FlightSettings type
 * below), edited from the UI with Edit Properties.
 */
(function () {
    const TYPE = 'starpi.flight';
    const SETTINGS_TYPE = 'starpi.flight-settings';
    const SETTINGS_ID = { namespace: '', key: 'starpi-flight-settings' };
    // History fed to a tracker before the window it reports on: long enough
    // to find the pad's ground level and a flight already in progress.
    const LOOKBACK_MS = 10 * 60 * 1000;
    const SOURCES = { alt: 'T_ALT_SPEED', accel: 'T_ACCELLERATION', gps: 'T_GPS' };

    // Thresholds editable from the UI, in the units the form shows.
    const SETTINGS = [
        { key: 'launchAccelG', name: 'Launch: acceleration above (g)' },
        { key: 'launchHoldMs', name: 'Launch: held for at least (ms)' },
        { key: 'launchSpeed', name: 'Launch: or vertical speed above (m/s)' },
        { key: 'burnoutAccelG', name: 'Burnout: acceleration below (g)' },
        { key: 'apogeeArmMs', name: 'Apogee: not before launch + (ms)' },
        { key: 'apogeeDropM', name: 'Apogee: or this far below the peak (m)' },
        { key: 'landedSpeed', name: 'Landed: |vertical speed| below (m/s)' },
        { key: 'landedAgl', name: 'Landed: height above ground below (m)' },
        { key: 'landedHoldMs', name: 'Landed: for at least (ms)' }
    ];

    function flightPoints() {
        const { PHASES } = window.StarPiFlight;
        const launched = (tracker) => tracker.launchTime !== null;

        return {
            'flight.phase': {
                name: 'Flight phase',
                format: 'enum',
                enumerations: PHASES.map((phase, index) => ({ value: index, string: phase })),
                on: ['alt', 'accel'],
                value: (tracker) => PHASES.indexOf(tracker.phase)
            },
            'flight.mission-time': {
                name: 'Mission time',
                format: 'starpi.mission-time',
                on: ['alt', 'accel'],
                value: (tracker, t) => {
                    if (!launched(tracker)) {
                        return null;
                    }
                    const landed = tracker.events.find((event) => event.phase === 'LANDED');

                    return ((landed ? landed.t : t) - tracker.launchTime) / 1000;
                }
            },
            'flight.agl': { name: 'Altitude above ground', precision: 1, unit: 'm', on: ['alt'], value: (tracker) => tracker.agl },
            'flight.accel': { name: 'Acceleration (total)', precision: 2, unit: 'g', on: ['accel'], value: (tracker) => tracker.accelG },
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

        /** FlightTracker options from the current settings. */
        options() {
            const options = {};
            for (const { key } of SETTINGS) {
                const value = numberOrNull(this.settings[key]);
                if (value !== null) {
                    options[key] = value;
                }
            }
            options.groundOverride = numberOrNull(this.settings.groundAltitude);

            return options;
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

            const now = Date.now();
            let samples = [];
            try {
                samples = await this.history(now - LOOKBACK_MS, now);
            } catch (error) {
                console.warn('StarPi: could not prime the flight estimates', error);
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
            for (const [key, callbacks] of this.listeners) {
                const point = this.points[key];
                if (!callbacks.size || !point.on.includes(s.kind)) {
                    continue;
                }
                const datum = datumFor(point, this.tracker, s.t);
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
                        for (const [k, point] of Object.entries(this.points)) {
                            if (point.on.includes(s.kind)) {
                                const datum = datumFor(point, tracker, s.t);
                                if (datum) {
                                    rows[k].push(datum);
                                }
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
            const end = options.end ?? Date.now();
            const start = options.start ?? end - LOOKBACK_MS;
            const rows = (await this.replay(start, end))[key];

            return options.strategy === 'latest' ? rows.slice(-1) : rows;
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
            const next = { ...configuration };
            if (JSON.stringify(next) === JSON.stringify(this.settings)) {
                return;
            }
            this.settings = next;
            this.restart();
            this.settingsListeners.forEach((callback) => callback(this.options()));
        }
    }

    function settingsType() {
        const { DEFAULTS } = window.StarPiFlight;

        return {
            name: 'Flight Settings',
            description: 'Thresholds the dashboard uses to estimate the flight phase and the ground level.',
            cssClass: 'icon-gear',
            creatable: false,
            initialize(domainObject) {
                domainObject.configuration = Object.fromEntries(SETTINGS.map(({ key }) => [key, DEFAULTS[key]]));
                domainObject.configuration.groundAltitude = '';
            },
            form: [
                ...SETTINGS.map(({ key, name }) => ({
                    key,
                    name,
                    control: 'numberfield',
                    cssClass: 'l-input-sm',
                    property: ['configuration', key]
                })),
                {
                    key: 'groundAltitude',
                    name: 'Ground level override (m MSL, empty = pad median)',
                    control: 'textfield',
                    cssClass: 'l-input-sm',
                    property: ['configuration', 'groundAltitude']
                }
            ]
        };
    }

    /** Read-only summary of the thresholds; they are edited with Edit Properties. */
    function settingsView(openmct) {
        const { DEFAULTS } = window.StarPiFlight;
        const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

        return {
            key: 'starpi.flight-settings-view',
            name: 'Flight Settings',
            cssClass: 'icon-gear',
            canView: (domainObject) => domainObject.type === SETTINGS_TYPE,
            view(domainObject) {
                let unobserve;
                const render = (element, configuration = {}) => {
                        const rows = SETTINGS.map(({ key, name }) => {
                            const value = configuration[key] ?? DEFAULTS[key];

                            return `<tr><td>${escape(name)}</td><td>${escape(value)}</td></tr>`;
                        });
                        const ground = configuration.groundAltitude === '' || configuration.groundAltitude === undefined
                            ? 'pad median'
                            : `${escape(configuration.groundAltitude)} m MSL`;
                        rows.push(`<tr><td>Ground level</td><td>${ground}</td></tr>`);
                        element.innerHTML = `
                            <div style="padding: 12px 16px; overflow: auto; height: 100%;">
                                <p style="margin: 0 0 12px;">Thresholds used to estimate the flight phase and the ground level.
                                    Change them with <strong>Edit Properties</strong> (the ⋯ menu); every flight view picks them up at once.</p>
                                <table class="c-table c-table--sortable" style="width: auto;">
                                    <thead><tr><th>Setting</th><th>Value</th></tr></thead>
                                    <tbody>${rows.join('')}</tbody>
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
    FlightService.SETTINGS = SETTINGS;
    window.StarPiFlightService = FlightService;
}());
