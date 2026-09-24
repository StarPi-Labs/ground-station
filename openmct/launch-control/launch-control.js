/*
 * "Launch Control": a single glanceable screen for flying the rocket.
 *
 * Reads the StarPi telemetry objects through Open MCT's telemetry API, so it
 * follows the time conductor: Real-time shows the live flight, Fixed replays
 * whatever window is selected. Backend health and commands come straight from
 * the REST API. Flight phase, ground level and records are estimated in
 * flight-state.js.
 */
(function () {
    const NAMESPACE = 'starpi';
    const TYPE = 'starpi.launch-control';

    const SOURCES = {
        alt: 'T_ALT_SPEED',
        accel: 'T_ACCELLERATION',
        gyro: 'T_GYRO',
        orient: 'T_ORIENTATION',
        pressure: 'T_PRESSURE',
        temp: 'T_TEMPERATURE',
        gps: 'T_GPS',
        log: 'T_SYSLOG'
    };

    const PHASE_LABELS = {
        PAD: 'On pad',
        BOOST: 'Boost',
        COAST: 'Coast',
        APOGEE: 'Apogee',
        DESCENT: 'Descent',
        LANDED: 'Landed'
    };

    const STALE_WARN_MS = 2000;
    const STALE_ALARM_MS = 5000;
    const RENDER_MS = 200;
    const HEALTH_POLL_MS = 2000;
    const HEALTH_TIMEOUT_MS = 1500;
    const API_TIMEOUT_MS = 8000;
    const COMMANDS_POLL_MS = 5000;
    const CONFIRM_TIMEOUT_MS = 8000;
    const MAX_LOG = 200;
    const GROUND_KEY = 'starpi.launch-control.ground';
    // Commands that stay out of the UI: raw_write can write anything anywhere.
    const HIDDEN_COMMANDS = new Set(['raw_write']);

    // --- formatting ------------------------------------------------------------

    function fixed(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits) : '—';
    }

    function signed(value, digits) {
        if (!Number.isFinite(value)) {
            return '—';
        }
        const text = Math.abs(value).toFixed(digits);

        return Number(text) === 0 ? text : `${value > 0 ? '+' : '−'}${text}`;
    }

    function missionTime(ms) {
        if (!Number.isFinite(ms)) {
            return '--:--.-';
        }
        const sign = ms < 0 ? '−' : '';
        const total = Math.abs(ms) / 1000;
        const minutes = Math.floor(total / 60);
        const seconds = total - minutes * 60;

        return `${sign}${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
    }

    function clock(ms) {
        return new Date(ms).toISOString().slice(11, 19);
    }

    function compass(bearing) {
        const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

        return points[Math.round(bearing / 45) % 8];
    }

    function distance(metres) {
        if (!Number.isFinite(metres)) {
            return '—';
        }

        return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(0)} m`;
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function readGround() {
        try {
            const value = JSON.parse(localStorage.getItem(GROUND_KEY));

            return Number.isFinite(value) ? value : null;
        } catch (error) {
            return null;
        }
    }

    function writeGround(value) {
        try {
            if (value === null) {
                localStorage.removeItem(GROUND_KEY);
            } else {
                localStorage.setItem(GROUND_KEY, JSON.stringify(value));
            }
        } catch (error) {
            // Private window or blocked storage: the pin just won't survive a reload.
        }
    }

    // --- markup ------------------------------------------------------------------

    function dial(axis) {
        return `
            <div class="lc-dial">
                <svg viewBox="-20 -20 40 40" aria-hidden="true">
                    <circle r="17" class="lc-dial__face"></circle>
                    <line y1="-17" y2="-13" class="lc-dial__tick"></line>
                    <line x1="0" y1="3" x2="0" y2="-14" class="lc-dial__needle" data-ref="orient-${axis}-needle"></line>
                    <circle r="2" class="lc-dial__hub"></circle>
                </svg>
                <span class="lc-dial__label">${axis.toUpperCase()}</span>
                <span class="lc-num lc-dial__value" data-ref="orient-${axis}">—</span>
            </div>`;
    }

    const TEMPLATE = `
        <div class="starpi-lc" data-ref="root">
            <div class="lc-grid">
            <div class="lc-alert" data-ref="alert" role="alert" hidden></div>

            <header class="lc-head">
                <div class="lc-clock">
                    <span class="lc-clock__label" data-ref="clock-label">Mission time</span>
                    <span class="lc-num lc-clock__value" data-ref="clock">--:--.-</span>
                </div>
                <ol class="lc-phases" data-ref="phases" aria-label="Flight phase (estimated)">
                    ${Object.entries(PHASE_LABELS).map(([key, label]) => `
                        <li class="lc-phase" data-phase="${key}">
                            <span class="lc-phase__name">${label}</span>
                            <span class="lc-num lc-phase__time" data-ref="phase-${key}"></span>
                        </li>`).join('')}
                </ol>
                <dl class="lc-health">
                    <div><dt>Link</dt><dd data-ref="links">—</dd></div>
                    <div><dt>Last packet</dt><dd class="lc-num" data-ref="age">—</dd></div>
                    <div><dt>Rate</dt><dd class="lc-num" data-ref="rate">—</dd></div>
                    <div><dt>Errors</dt><dd class="lc-num" data-ref="errors">—</dd></div>
                </dl>
            </header>

            <section class="lc-panel lc-primary" aria-label="Flight readouts">
                <div class="lc-readout lc-readout--hero">
                    <span class="lc-readout__label">Altitude above ground</span>
                    <span class="lc-readout__value"><span class="lc-num" data-ref="agl">—</span><span class="lc-unit">m</span></span>
                    <span class="lc-readout__note" data-ref="ground-note">&nbsp;</span>
                    <span class="lc-ground">
                        <button type="button" class="lc-button lc-button--quiet" data-ref="zero">Set ground here</button>
                        <button type="button" class="lc-button lc-button--quiet" data-ref="unzero" hidden>Use pad median</button>
                    </span>
                </div>
                <div class="lc-readout">
                    <span class="lc-readout__label">Vertical speed</span>
                    <span class="lc-readout__value"><span class="lc-num" data-ref="speed">—</span><span class="lc-unit">m/s</span></span>
                </div>
                <div class="lc-readout">
                    <span class="lc-readout__label">Acceleration</span>
                    <span class="lc-readout__value"><span class="lc-num" data-ref="accel">—</span><span class="lc-unit">g</span></span>
                </div>
                <dl class="lc-records" aria-label="Flight records">
                    <div><dt>Apogee</dt><dd><span class="lc-num" data-ref="apogee">—</span> <span class="lc-unit">m</span></dd><dd class="lc-num lc-records__when" data-ref="apogee-time"></dd></div>
                    <div><dt>Max speed</dt><dd><span class="lc-num" data-ref="max-speed">—</span> <span class="lc-unit">m/s</span></dd></div>
                    <div><dt>Max accel</dt><dd><span class="lc-num" data-ref="max-accel">—</span> <span class="lc-unit">g</span></dd></div>
                </dl>
            </section>

            <section class="lc-panel lc-charts" aria-label="Flight charts">
                <div class="lc-chart">
                    <h3 class="lc-title">Altitude above ground <span class="lc-unit">m</span></h3>
                    <canvas data-ref="chart-alt"></canvas>
                </div>
                <div class="lc-chart">
                    <h3 class="lc-title">Vertical speed <span class="lc-unit">m/s</span></h3>
                    <canvas data-ref="chart-speed"></canvas>
                </div>
                <div class="lc-chart">
                    <h3 class="lc-title">Acceleration <span class="lc-unit">g</span></h3>
                    <canvas data-ref="chart-accel"></canvas>
                </div>
                <p class="lc-empty" data-ref="charts-empty">Loading telemetry…</p>
            </section>

            <section class="lc-panel lc-gps" aria-label="Position">
                <h3 class="lc-title">Position from pad</h3>
                <canvas class="lc-range" data-ref="range"></canvas>
                <dl class="lc-pairs">
                    <div><dt>Distance</dt><dd class="lc-num" data-ref="gps-distance">—</dd></div>
                    <div><dt>Bearing</dt><dd class="lc-num" data-ref="gps-bearing">—</dd></div>
                    <div><dt>Latitude</dt><dd class="lc-num" data-ref="gps-lat">—</dd></div>
                    <div><dt>Longitude</dt><dd class="lc-num" data-ref="gps-lon">—</dd></div>
                </dl>
            </section>

            <section class="lc-panel lc-attitude" aria-label="Attitude and environment">
                <h3 class="lc-title">Orientation <span class="lc-unit">°</span></h3>
                <div class="lc-dials">${['x', 'y', 'z'].map(dial).join('')}</div>
                <dl class="lc-pairs lc-pairs--three">
                    <div><dt>Gyro X</dt><dd class="lc-num" data-ref="gyro-x">—</dd></div>
                    <div><dt>Gyro Y</dt><dd class="lc-num" data-ref="gyro-y">—</dd></div>
                    <div><dt>Gyro Z</dt><dd class="lc-num" data-ref="gyro-z">—</dd></div>
                </dl>
                <p class="lc-hint">Gyro in °/s. Axes as reported by the flight computer.</p>
                <h3 class="lc-title">Environment</h3>
                <dl class="lc-pairs">
                    <div><dt>Pressure</dt><dd><span class="lc-num" data-ref="pressure">—</span> <span class="lc-unit">hPa</span></dd></div>
                    <div><dt>Temperature</dt><dd><span class="lc-num" data-ref="temp">—</span> <span class="lc-unit">°C</span></dd></div>
                </dl>
            </section>

            <section class="lc-panel lc-log" aria-label="System log">
                <h3 class="lc-title">System log</h3>
                <ol class="lc-log__list" data-ref="log"></ol>
                <p class="lc-empty lc-empty--inline" data-ref="log-empty">No log messages in this time window.</p>
            </section>

            <section class="lc-panel lc-commands" aria-label="Commands">
                <h3 class="lc-title">Commands</h3>
                <ul class="lc-commands__list" data-ref="commands"></ul>
                <p class="lc-result" data-ref="command-result" role="status"></p>
                <h3 class="lc-title lc-title--minor">Recent</h3>
                <ol class="lc-history" data-ref="history"></ol>
            </section>
            </div>
        </div>`;

    // --- view ------------------------------------------------------------------

    class LaunchControlView {
        constructor(openmct, apiUrl) {
            this.openmct = openmct;
            this.apiUrl = apiUrl;
            this.generation = 0;
            this.unsubscribers = [];
            this.timers = [];
            this.health = null;
            this.healthOk = false;
            this.available = [];
            this.history = [];
            this.pendingConfirm = null;
            this.onBounds = this.onBounds.bind(this);
            this.onMode = this.onMode.bind(this);
        }

        show(element) {
            element.innerHTML = TEMPLATE;
            this.element = element;
            this.refs = {};
            element.querySelectorAll('[data-ref]').forEach((node) => {
                // Both spellings: `refs['phase-PAD']` for generated names, `refs.chartAlt` elsewhere.
                const name = node.dataset.ref;
                this.refs[name] = node;
                this.refs[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = node;
            });

            this.refs.zero.addEventListener('click', () => this.pinGround(this.tracker.altitude));
            this.refs.unzero.addEventListener('click', () => this.pinGround(null));
            this.refs.commands.addEventListener('click', (event) => this.onCommandClick(event));

            this.resize = new ResizeObserver(() => {
                this.chartsDirty = true;
            });
            this.resize.observe(this.refs.root);

            this.openmct.time.on('boundsChanged', this.onBounds);
            this.openmct.time.on('modeChanged', this.onMode);
            this.openmct.time.on('clockChanged', this.onMode);

            this.subscribe().then(() => this.load());
            this.pollHealth();
            this.pollCommands();
            this.timers.push(setInterval(() => this.render(), RENDER_MS));
            this.timers.push(setInterval(() => this.pollHealth(), HEALTH_POLL_MS));
            this.timers.push(setInterval(() => this.pollCommands(), COMMANDS_POLL_MS));
        }

        destroy() {
            this.generation += 1;
            this.destroyed = true;
            this.unsubscribers.forEach((unsubscribe) => unsubscribe());
            this.timers.forEach((timer) => clearInterval(timer));
            clearTimeout(this.confirmTimer);
            this.resize?.disconnect();
            this.openmct.time.off('boundsChanged', this.onBounds);
            this.openmct.time.off('modeChanged', this.onMode);
            this.openmct.time.off('clockChanged', this.onMode);
        }

        // --- data ------------------------------------------------------------

        async subscribe() {
            const objects = {};
            await Promise.all(Object.entries(SOURCES).map(async ([name, key]) => {
                objects[name] = await this.openmct.objects.get({ namespace: NAMESPACE, key });
            }));
            if (this.destroyed) {
                return;
            }
            for (const [name, object] of Object.entries(objects)) {
                this.unsubscribers.push(
                    this.openmct.telemetry.subscribe(object, (datum) => this.onLive(name, datum))
                );
            }
            // Set last: load() waits for the complete set.
            this.objects = objects;
        }

        onBounds(bounds, isTick) {
            if (isTick) {
                this.chartsDirty = true;

                return;
            }
            this.load();
        }

        onMode() {
            this.load();
        }

        reset() {
            this.tracker = new window.StarPiFlight.FlightTracker({ groundOverride: readGround() });
            this.series = { alt: [], speed: [], accel: [] };
            this.latest = {};
            this.logEntries = [];
            this.lastId = {};
            this.liveQueue = [];
            this.receivedAt = [];
            this.lastReceived = null;
            this.chartsDirty = true;
            this.logDirty = true;
        }

        /** (Re)load history for the conductor's window, then replay queued live data. */
        async load() {
            if (!this.objects || this.destroyed) {
                return;
            }
            const generation = ++this.generation;
            this.reset();
            this.loading = true;
            this.refs.chartsEmpty.textContent = 'Loading telemetry…';

            const bounds = this.openmct.time.getBounds();
            let results;
            try {
                results = await Promise.all(Object.entries(this.objects).map(async ([name, object]) => {
                    const data = await this.openmct.telemetry.request(object, {
                        start: bounds.start,
                        end: bounds.end
                    });

                    return [name, data];
                }));
            } catch (error) {
                if (generation === this.generation) {
                    this.loading = false;
                    this.refs.chartsEmpty.textContent = `Could not load telemetry: ${error.message}`;
                }

                return;
            }
            if (generation !== this.generation) {
                return;
            }

            // Merge every source into one time-ordered stream for the tracker.
            const merged = [];
            for (const [name, data] of results) {
                for (const datum of data) {
                    merged.push([name, datum]);
                    if (Number.isFinite(datum.id)) {
                        this.lastId[name] = Math.max(this.lastId[name] ?? -Infinity, datum.id);
                    }
                }
            }
            merged.sort((a, b) => a[1].utc - b[1].utc);
            merged.forEach(([name, datum]) => this.ingest(name, datum));

            this.loading = false;
            const queued = this.liveQueue;
            this.liveQueue = [];
            queued.forEach(([name, datum]) => this.onLive(name, datum));
            this.render();
        }

        onLive(name, datum) {
            if (!this.tracker || !this.openmct.time.isRealTime()) {
                return;
            }
            if (this.loading) {
                this.liveQueue.push([name, datum]);

                return;
            }
            if (Number.isFinite(datum.id) && datum.id <= (this.lastId[name] ?? -Infinity)) {
                return;
            }

            const now = Date.now();
            this.lastReceived = now;
            this.receivedAt.push(now);
            this.ingest(name, datum);
        }

        ingest(name, datum) {
            const t = datum.utc;
            if (Number.isFinite(datum.id)) {
                this.lastId[name] = Math.max(this.lastId[name] ?? -Infinity, datum.id);
            }

            switch (name) {
            case 'alt':
                this.tracker.update({ t, kind: 'alt', altitude: datum.altitude, speed: datum.speed });
                this.series.alt.push({ t, v: datum.altitude });
                this.series.speed.push({ t, v: datum.speed });
                this.chartsDirty = true;
                break;
            case 'accel': {
                this.tracker.update({ t, kind: 'accel', x: datum.x, y: datum.y, z: datum.z });
                const g = window.StarPiFlight.magnitude(datum) / window.StarPiFlight.G;
                this.series.accel.push({ t, v: g });
                this.chartsDirty = true;
                break;
            }
            case 'gps':
                this.tracker.update({ t, kind: 'gps', lat: datum.lat, lon: datum.lon });
                break;
            case 'log':
                this.logEntries.push({ t, message: datum.message });
                if (this.logEntries.length > MAX_LOG) {
                    this.logEntries.shift();
                }
                this.logDirty = true;
                break;
            default:
                this.latest[name] = datum;
            }
        }

        pinGround(altitude) {
            if (altitude !== null && !Number.isFinite(altitude)) {
                return;
            }
            writeGround(altitude);
            this.tracker.setGround(altitude);
            this.chartsDirty = true;
            this.render();
        }

        // --- backend polling ---------------------------------------------------

        /** JSON call with a deadline: a stopped backend can keep Apache waiting for tens of seconds. */
        async api(path, options = {}, timeoutMs = API_TIMEOUT_MS) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetch(this.apiUrl + path, { ...options, signal: controller.signal });
            } catch (error) {
                throw new Error(error.name === 'AbortError' ? 'backend did not answer in time' : error.message);
            } finally {
                clearTimeout(timer);
            }
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(body.detail || `HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            return body;
        }

        async pollHealth() {
            if (this.healthInFlight) {
                return;
            }
            this.healthInFlight = true;
            try {
                this.health = await this.api('/health', {}, HEALTH_TIMEOUT_MS);
                this.healthOk = true;
            } catch (error) {
                this.healthOk = false;
            } finally {
                this.healthInFlight = false;
            }
        }

        async pollCommands() {
            if (this.commandsInFlight) {
                return;
            }
            this.commandsInFlight = true;
            try {
                const [available, history] = await Promise.all([
                    this.api('/commands/available'),
                    this.api('/commands?limit=5')
                ]);
                this.available = available.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name));
                this.history = history.commands;
            } catch (error) {
                // Health polling already reports an unreachable backend.
            } finally {
                this.commandsInFlight = false;
            }
            if (!this.destroyed) {
                this.renderCommands();
            }
        }

        linkUp(name) {
            return Boolean(this.healthOk && this.health?.links.some((l) => l.name === name && l.connected));
        }

        onCommandClick(event) {
            const button = event.target.closest('button[data-action]');
            if (!button) {
                return;
            }
            const { action, command, link } = button.dataset;

            if (action === 'arm') {
                this.pendingConfirm = `${command}@${link}`;
                clearTimeout(this.confirmTimer);
                this.confirmTimer = setTimeout(() => {
                    this.pendingConfirm = null;
                    this.renderCommands();
                }, CONFIRM_TIMEOUT_MS);
            } else if (action === 'cancel') {
                this.pendingConfirm = null;
            } else if (action === 'send') {
                this.pendingConfirm = null;
                this.send(command, link);
            }
            this.renderCommands();
            this.refs.commands.querySelector('button[data-action]:not([disabled])')?.focus();
        }

        async send(name, link) {
            const result = this.refs.commandResult;
            result.className = 'lc-result';
            result.textContent = `Sending ${name}…`;
            try {
                await this.api('/commands', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, args: {}, link })
                });
                result.classList.add('is-ok');
                result.textContent = `${name} sent over ${link} at ${clock(Date.now())}`;
            } catch (error) {
                result.classList.add('is-alarm');
                const reason = error.status === 503 ? 'rocket unreachable' : error.message;
                result.textContent = `${name} failed: ${reason}`;
            }
            this.pollCommands();
        }

        // --- rendering -----------------------------------------------------------

        render() {
            if (!this.tracker || this.destroyed) {
                return;
            }
            const realtime = this.openmct.time.isRealTime();
            const bounds = this.openmct.time.getBounds();
            const now = realtime ? Date.now() : bounds.end;
            const flight = this.tracker.snapshot();

            if (realtime) {
                this.trim(bounds.start);
            }
            this.renderStatus(flight, realtime, now);
            this.renderReadouts(flight);
            this.renderSecondary(flight);
            if (this.logDirty) {
                this.renderLog(flight);
            }
            if (this.chartsDirty) {
                this.renderCharts(flight, bounds);
            }
        }

        trim(start) {
            for (const series of Object.values(this.series)) {
                let drop = 0;
                while (drop < series.length && series[drop].t < start - 5000) {
                    drop += 1;
                }
                if (drop) {
                    series.splice(0, drop);
                }
            }
            const cutoff = Date.now() - 5000;
            while (this.receivedAt.length && this.receivedAt[0] < cutoff) {
                this.receivedAt.shift();
            }
        }

        renderStatus(flight, realtime, now) {
            const { refs } = this;

            // Mission clock: T+ from launch, frozen at landing.
            const landing = flight.events.find((e) => e.phase === 'LANDED');
            if (flight.launchTime === null) {
                refs.clockLabel.textContent = 'Mission time';
                refs.clock.textContent = 'T+ --:--.-';
            } else {
                const end = landing ? landing.t : now;
                refs.clockLabel.textContent = landing ? 'Flight time' : 'Mission time';
                refs.clock.textContent = `T+ ${missionTime(end - flight.launchTime)}`;
            }

            // Phase strip.
            const reached = new Map(flight.events.map((e) => [e.phase, e.t]));
            refs.phases.querySelectorAll('.lc-phase').forEach((node) => {
                const phase = node.dataset.phase;
                const current = phase === flight.phase;
                node.classList.toggle('is-current', current);
                node.classList.toggle('is-done', reached.has(phase) && !current);
                if (current) {
                    node.setAttribute('aria-current', 'step');
                } else {
                    node.removeAttribute('aria-current');
                }
                const t = reached.get(phase);
                refs[`phase-${phase}`].textContent = t !== undefined && flight.launchTime !== null
                    ? `T+ ${missionTime(t - flight.launchTime)}`
                    : '';
            });

            // Backend health.
            const links = this.health?.links ?? [];
            const upLinks = links.filter((l) => l.connected).map((l) => l.name);
            refs.links.textContent = !this.healthOk ? 'offline'
                : upLinks.length ? `${upLinks.join(', ')} up` : 'down';
            refs.links.className = !this.healthOk || !upLinks.length ? 'is-alarm' : 'is-ok';

            const errors = this.health
                ? this.health.decode_errors + this.health.store_errors + this.health.dropped_events
                : null;
            refs.errors.textContent = errors === null ? '—' : String(errors);
            refs.errors.className = `lc-num${errors ? ' is-warn' : ''}`;
            refs.errors.title = this.health
                ? `decode ${this.health.decode_errors}, store ${this.health.store_errors}, dropped ${this.health.dropped_events}`
                : '';

            let alert = null;
            let level = 'alarm';
            if (realtime) {
                const age = this.lastReceived === null ? null : now - this.lastReceived;
                refs.age.textContent = age === null ? 'waiting' : `${(age / 1000).toFixed(1)} s ago`;
                refs.age.className = `lc-num${age === null || age > STALE_ALARM_MS ? ' is-alarm' : age > STALE_WARN_MS ? ' is-warn' : ''}`;
                refs.rate.textContent = `${(this.receivedAt.length / 5).toFixed(0)} pkt/s`;

                if (!this.healthOk) {
                    alert = 'Backend unreachable — readouts are frozen.';
                } else if (!upLinks.length) {
                    alert = 'No link to the rocket.';
                } else if (age !== null && age > STALE_ALARM_MS) {
                    alert = `No telemetry for ${(age / 1000).toFixed(0)} s.`;
                } else if (age !== null && age > STALE_WARN_MS) {
                    alert = `Telemetry delayed: last packet ${(age / 1000).toFixed(1)} s ago.`;
                    level = 'warn';
                }
                refs.root.classList.toggle('is-stale', age === null || age > STALE_WARN_MS);
            } else {
                refs.age.textContent = 'replay';
                refs.age.className = 'lc-num';
                refs.rate.textContent = '—';
                refs.root.classList.remove('is-stale');
            }
            refs.alert.hidden = alert === null;
            refs.alert.textContent = alert ?? '';
            refs.alert.className = `lc-alert is-${level}`;
        }

        renderReadouts(flight) {
            const { refs } = this;
            refs.agl.textContent = fixed(flight.agl, 1);
            refs.speed.textContent = signed(flight.speed, 1);
            refs.accel.textContent = fixed(flight.accelG, 2);

            refs.groundNote.textContent = flight.ground === null
                ? 'Ground level: waiting for data'
                : `${fixed(flight.altitude, 1)} m MSL · ground ${fixed(flight.ground, 1)} m (${flight.groundPinned ? 'set by hand' : 'pad median'})`;
            refs.zero.disabled = flight.altitude === null;
            refs.unzero.hidden = !flight.groundPinned;

            const launched = flight.launchTime !== null;
            refs.apogee.textContent = flight.apogee ? fixed(flight.apogee.agl, 1) : launched ? fixed(flight.maxAgl, 1) : '—';
            refs.apogeeTime.textContent = flight.apogee
                ? `at T+ ${missionTime(flight.apogee.t - flight.launchTime)}`
                : launched ? 'so far' : '';
            refs.maxSpeed.textContent = launched ? fixed(flight.maxSpeed, 1) : '—';
            refs.maxAccel.textContent = launched ? fixed(flight.maxAccelG, 2) : '—';
        }

        renderSecondary(flight) {
            const { refs, latest } = this;

            for (const axis of ['x', 'y', 'z']) {
                const angle = latest.orient?.[axis];
                refs[`orient-${axis}`].textContent = fixed(angle, 1);
                refs[`orient-${axis}-needle`].setAttribute('transform', `rotate(${Number.isFinite(angle) ? angle : 0})`);
                refs[`gyro-${axis}`].textContent = fixed(latest.gyro?.[axis], 1);
            }
            refs.pressure.textContent = fixed(latest.pressure?.value, 2);
            refs.temp.textContent = fixed(latest.temp?.value, 1);

            refs.gpsLat.textContent = flight.fix ? `${flight.fix.lat.toFixed(6)}°` : '—';
            refs.gpsLon.textContent = flight.fix ? `${flight.fix.lon.toFixed(6)}°` : '—';
            refs.gpsDistance.textContent = flight.fromPad ? distance(flight.fromPad.distance) : '—';
            refs.gpsBearing.textContent = flight.fromPad && flight.fromPad.distance >= 1
                ? `${flight.fromPad.bearing.toFixed(0)}° ${compass(flight.fromPad.bearing)}`
                : '—';

            const key = flight.fix ? `${flight.fix.t}` : 'none';
            if (key !== this.rangeKey || this.chartsDirty) {
                this.rangeKey = key;
                window.StarPiCharts.drawRange(refs.range, flight, window.StarPiFlight.localOffset);
            }
        }

        renderLog(flight) {
            this.logDirty = false;
            const entries = this.logEntries.slice(-60).reverse();
            this.refs.logEmpty.hidden = entries.length > 0;
            this.refs.log.innerHTML = entries.map((entry) => {
                const when = flight.launchTime !== null && entry.t >= flight.launchTime
                    ? `T+ ${missionTime(entry.t - flight.launchTime)}`
                    : clock(entry.t);

                return `<li><time class="lc-num">${when}</time><span>${escapeHtml(entry.message)}</span></li>`;
            }).join('');
        }

        renderCharts(flight, bounds) {
            this.chartsDirty = false;
            const { refs, series } = this;
            const ground = flight.ground ?? 0;
            // Descent follows apogee by two seconds: its rule would only crowd the charts.
            const events = flight.events
                .filter((e) => e.phase !== 'DESCENT')
                .map((e) => ({ t: e.t, label: PHASE_LABELS[e.phase] }));
            const window_ = { start: bounds.start, end: bounds.end, events };

            const hasData = series.alt.length || series.accel.length;
            refs.chartsEmpty.hidden = this.loading ? false : Boolean(hasData);
            if (!this.loading && !hasData) {
                refs.chartsEmpty.textContent = 'No telemetry in this time window.';
            }

            window.StarPiCharts.drawStrip(refs.chartAlt, {
                ...window_,
                series: series.alt.map((p) => ({ t: p.t, v: p.v - ground })),
                floor: 10
            });
            window.StarPiCharts.drawStrip(refs.chartSpeed, { ...window_, series: series.speed, zero: true, floor: 4 });
            window.StarPiCharts.drawStrip(refs.chartAccel, { ...window_, series: series.accel, floor: 1 });
        }

        renderCommands() {
            const { refs } = this;
            if (!this.available.length) {
                refs.commands.innerHTML = `<li class="lc-empty lc-empty--inline">${this.healthOk ? 'No link offers commands.' : 'Backend unreachable.'}</li>`;
            } else {
                refs.commands.innerHTML = this.available.map((command) => {
                    const id = `${command.name}@${command.link}`;
                    const up = this.linkUp(command.link);
                    const name = escapeHtml(command.name);
                    const link = escapeHtml(command.link);
                    const data = `data-command="${name}" data-link="${link}"`;
                    const actions = this.pendingConfirm === id && up
                        ? `<span class="lc-confirm">Send to the rocket?</span>
                           <button type="button" class="lc-button lc-button--danger" data-action="send" ${data}>Confirm</button>
                           <button type="button" class="lc-button lc-button--quiet" data-action="cancel" ${data}>Cancel</button>`
                        : `<button type="button" class="lc-button" data-action="arm" ${data} ${up ? '' : 'disabled'}
                             title="${up ? '' : `${link} link is down`}">Send…</button>`;

                    return `<li class="lc-command">
                        <div class="lc-command__text">
                            <code>${name}</code> <span class="lc-command__link">via ${link}</span>
                            <p>${escapeHtml(command.description)}</p>
                        </div>
                        <div class="lc-command__actions">${actions}</div>
                    </li>`;
                }).join('');
            }

            refs.history.innerHTML = this.history.length
                ? this.history.map((c) => `<li>
                    <time class="lc-num">${clock(c.created_at_us / 1000)}</time>
                    <code>${escapeHtml(c.name)}</code>
                    <span class="lc-status ${c.status === 'sent' ? 'is-ok' : c.status === 'failed' ? 'is-alarm' : ''}"
                          title="${escapeHtml(c.error || '')}">${escapeHtml(c.status)}</span>
                  </li>`).join('')
                : '<li class="lc-empty lc-empty--inline">No commands sent yet.</li>';
        }
    }

    // --- plugin ----------------------------------------------------------------

    window.StarPiLaunchControl = function StarPiLaunchControl(config = {}) {
        const apiUrl = config.apiUrl || '/api';

        return function install(openmct) {
            openmct.types.addType(TYPE, {
                name: 'Launch Control',
                description: 'Flight dashboard for the StarPi rocket.',
                cssClass: 'icon-telemetry-panel'
            });

            openmct.objectViews.addProvider({
                key: 'starpi.launch-control-view',
                name: 'Launch Control',
                cssClass: 'icon-telemetry-panel',
                canView(domainObject) {
                    return domainObject.type === TYPE;
                },
                view() {
                    return new LaunchControlView(openmct, apiUrl);
                },
                priority() {
                    return 1;
                }
            });
        };
    };
}());
