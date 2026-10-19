/*
 * Focused workspaces extending the existing StarPi visual system. Launch
 * Control and its saved settings remain independent of these views.
 * Map: a large ground track and recovery coordinates. Dynamics: attitude
 * beside four plots. Commands: the existing guarded panel with link context.
 * Logs: a searchable, bounded event stream. Diagnostics: live station health.
 * All flight data follows the Open MCT conductor; station health and commands
 * are explicitly live even when the flight conductor is in replay mode.
 */
(function () {
    const TYPE = 'starpi.sector';
    const MAX_LOG = 2000;
    const MAX_SERIES = 12000;
    const LOOKBACK = 10 * 60 * 1000;
    const metric = (key, label, unit, digits, source, plot = false) => ({ key, label, unit, digits, source, plot });
    const altitude = metric('flight.agl', 'Altitude above ground', 'm', 1, 'T_FILTER_STATE', true);
    const speed = metric('baro.speed', 'Vertical speed', 'm/s', 1, 'T_FILTER_STATE', true);
    const phase = metric('flight.phase', 'Flight phase', '', 0, 'T_ROCKET_STATE');
    const definitions = {
        'map-dashboard': {
            name: 'Map & Recovery', short: 'Map',
            description: 'Ground track, pad reference and recovery coordinates.',
            channels: [altitude, speed, phase,
                { key: 'T_GPS', raw: true }, { key: 'T_ROCKET_STATE', raw: true }]
        },
        'commands-dashboard': {
            name: 'Command Centre', short: 'Commands',
            description: 'Rocket commands, link availability and recent acknowledgements.',
            channels: [altitude, speed, phase]
        },
        'dynamics-dashboard': {
            name: 'Flight Dynamics', short: 'Dynamics',
            description: 'Vertical motion, acceleration and rocket attitude.',
            channels: [altitude, speed,
                metric('flight.accel', 'Total acceleration', 'g', 2, 'T_ACCELLERATION', true),
                metric('flight.lateral-accel', 'Lateral acceleration', 'g', 2, 'T_ACCELLERATION', true),
                ...['x', 'y', 'z'].map((axis) => metric(`imu.gyro.${axis}`, `Angular rate ${axis.toUpperCase()}`, '°/s', 2, 'T_GYRO')),
                phase]
        },
        'logs-dashboard': {
            name: 'Mission Logs', short: 'Logs',
            description: 'Rocket text messages in the selected time window.',
            channels: [{ key: 'T_SYSLOG', raw: true }]
        },
        'diagnostics-dashboard': {
            name: 'Station Diagnostics', short: 'Diagnostics',
            description: 'Live transport, packet flow and storage health.', channels: []
        }
    };
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
    const fixed = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
    const href = (key) => `#/browse/starpi:root/starpi:${key}`;
    function navigation(activeKey) {
        const dashboards = [['launch-control', 'Launch Control'],
            ...Object.entries(definitions).map(([key, definition]) => [key, definition.short])];
        return `<nav class="sp-dashboard-nav" aria-label="StarPi dashboards">${dashboards.map(([key, name]) =>
            `<a href="${href(key)}"${key === activeKey ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav>`;
    }
    const clock = (utc) => new Date(utc).toISOString().slice(11, 23);
    const pairs = (items) => `<dl class="ss-pairs">${items.map(([label, key]) =>
        `<div><dt>${label}</dt><dd data-value="${key}">—</dd></div>`).join('')}</dl>`;
    const panel = (title, body, extra = '') => `<section class="ss-panel ${extra}"><h3>${title}</h3>${body}</section>`;

    function metricMarkup(channel) {
        return `<div class="ss-metric"><dt>${channel.label}</dt><dd><span data-metric="${channel.key}">—</span>
            <small>${channel.unit}</small></dd></div>`;
    }

    function content(key, definition) {
        const readouts = `<dl class="ss-readouts">${definition.channels.filter((c) => !c.raw && c.key !== phase.key && (key !== 'dynamics-dashboard' || c.plot))
            .map(metricMarkup).join('')}</dl>`;
        if (key === 'map-dashboard') {
            return `<div class="ss-map-layout">
                ${panel('Position from pad', `<div class="ss-map-tools" data-ref="map-tools" hidden>
                    <span>Background</span>${['off', 'map', 'satellite'].map((mode) =>
                        `<button type="button" data-mode="${mode}" aria-pressed="false">${{ off: 'Track only', map: 'Map', satellite: 'Satellite' }[mode]}</button>`).join('')}</div>
                    <div class="ss-map-stage"><div class="ss-basemap" data-ref="basemap" hidden></div>
                    <canvas data-ref="range" role="img" aria-label="Rocket ground track relative to the launch pad"></canvas></div>
                    <p class="ss-note" data-ref="map-note">Waiting for GPS telemetry.</p>`, 'ss-map-panel')}
                <aside class="ss-sidebar">${panel('Recovery', pairs([
                    ['Distance from pad', 'distance'], ['Bearing from pad', 'bearing'],
                    ['Rocket latitude', 'lat'], ['Rocket longitude', 'lon'],
                    ['Pad latitude', 'pad-lat'], ['Pad longitude', 'pad-lon'], ['GPS sample · UTC', 'gps-time']
                ]) + '<button type="button" data-ref="copy" disabled>Copy rocket coordinates</button><p class="ss-note" data-ref="copy-result" role="status"></p>')}
                ${panel('Flight context', readouts)}
                <p class="ss-note ss-legend">Square: launch pad · dot: rocket<br>North is up. Distances are measured from the pad.</p></aside></div>`;
        }
        if (key === 'commands-dashboard') {
            return `<div class="ss-command-layout">${panel('Command console',
                '<p class="ss-note">Commands act on the live rocket. Each send requires confirmation; pyrotechnics also require unlocking.</p><div data-ref="commands"></div>', 'ss-command-panel')}
                <aside class="ss-sidebar">${panel('Live links', '<div data-ref="links"></div>')}
                ${panel('Flight context · selected window', readouts)}
                <p class="ss-note">A confirmation or a pyrotechnic unlock is local to this panel. Opening another dashboard closes it.</p></aside></div>`;
        }
        if (key === 'dynamics-dashboard') {
            const gyro = `<dl class="ss-readouts ss-gyro">${definition.channels.filter((c) => c.source === 'T_GYRO').map(metricMarkup).join('')}</dl>`;
            return `${readouts}<div class="ss-dynamics-layout">${panel('Rocket attitude', '<div class="ss-rocket" data-ref="rocket"></div>' + gyro, 'ss-attitude')}
                <div class="ss-plots">${definition.channels.filter((c) => c.plot).map((c) => panel(
                    `${c.label} <small>${c.unit}</small>`, `<canvas data-chart="${c.key}" role="img" aria-label="${c.label} over time"></canvas><p class="ss-note" data-empty="${c.key}">Loading telemetry…</p>`
                )).join('')}</div></div>`;
        }
        if (key === 'logs-dashboard') {
            return `<div class="ss-log-tools"><label>Search messages <input type="search" data-ref="search" placeholder="Filter rocket messages"></label>
                <button type="button" data-ref="pause" aria-pressed="false">Pause display</button>
                <button type="button" data-ref="export">Export filtered CSV</button>
                <span class="ss-note" data-ref="log-count" role="status"></span></div>
                <p class="ss-note">Newest first · UTC on the rocket clock · up to ${MAX_LOG.toLocaleString('en')} text messages · numeric sensor logs are available under Telemetry.</p>
                <div class="ss-log-table"><table><thead><tr><th scope="col">Time · UTC</th><th scope="col">Message</th></tr></thead><tbody data-ref="log"></tbody></table></div>
                <p class="ss-empty" data-ref="log-empty">Loading messages…</p>`;
        }
        return `<p class="ss-live-note">Station diagnostics are live. The time conductor controls flight telemetry only.</p>
            <dl class="ss-readouts">${[
                ['Packet rate', 'rate', 'pkt/s'], ['Decode errors', 'decode', ''],
                ['Store errors', 'store', ''], ['Dropped events', 'dropped', '']
            ].map(([label, key, unit]) => `<div class="ss-metric"><dt>${label}</dt><dd><span data-value="${key}">—</span> <small>${unit}</small></dd></div>`).join('')}</dl>
            <div class="ss-diagnostic-layout">${panel('Transport links', '<div data-ref="links"></div>')}
            ${panel('Backend & storage', pairs([
                ['Backend', 'backend'], ['WebSocket', 'websocket'], ['Database integrity', 'storage'],
                ['Run', 'run'], ['Rocket clock · UTC', 'rocket-time']
            ]))}</div>`;
    }

    class SectorView {
        constructor(openmct, key) {
            this.openmct = openmct;
            this.dashboardKey = key;
            this.definition = definitions[key];
            this.off = [];
            this.generation = 0;
            this.rows = {};
            this.latest = {};
            this.queue = [];
            this.logEntries = [];
            this.displayEntries = [];
            this.dirty = true;
            this.onBounds = (_bounds, tick) => { if (!tick) this.load(); };
            this.onMode = () => this.load();
        }

        show(element) {
            this.element = element;
            element.innerHTML = `<div class="starpi-lc starpi-sectors ss-${this.dashboardKey}">
                ${navigation(this.dashboardKey)}
                <header class="ss-header"><div><h2>${this.definition.name}</h2><p>${this.definition.description}</p></div>
                    <div class="ss-status"><span data-ref="mode"></span><span data-ref="phase"></span><span data-ref="connection"></span></div></header>
                <div class="ss-error" data-ref="error" role="status" hidden></div>
                <main class="ss-body">${content(this.dashboardKey, this.definition)}</main>
                <footer class="ss-footer"><span data-ref="load-state">Loading telemetry…</span><button type="button" data-ref="reload">Reload window</button></footer></div>`;
            this.refs = {};
            element.querySelectorAll('[data-ref]').forEach((node) => {
                this.refs[node.dataset.ref.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = node;
            });
            this.refs.reload.addEventListener('click', () => this.load());
            this.openmct.time.on('boundsChanged', this.onBounds);
            this.openmct.time.on('modeChanged', this.onMode);
            this.openmct.time.on('clockChanged', this.onMode);
            this.off.push(window.StarPiTheme.onChange(() => { this.dirty = true; }));
            this.off.push(window.StarPi.flight.onSettings(() => this.load()));
            this.resize = new ResizeObserver(() => { this.dirty = true; });
            this.resize.observe(element);
            if (this.refs.commands) this.commands = new window.StarPiCommandsPanel(this.refs.commands);
            if (this.refs.rocket) {
                this.rocket = new window.StarPiRocketView.View(this.openmct);
                this.rocket.show(this.refs.rocket);
            }
            if (this.refs.basemap) this.initMap();
            if (this.refs.search) this.initLog();
            this.start().catch((error) => this.showError(error.message));
            this.timer = setInterval(() => this.render(), 250);
            this.render();
        }

        async start() {
            const objects = await Promise.all(this.definition.channels.map((channel) =>
                this.openmct.objects.get({ namespace: 'starpi', key: channel.key })));
            if (this.destroyed) return;
            this.objects = objects;
            objects.forEach((object, i) => {
                const channel = this.definition.channels[i];
                this.off.push(this.openmct.telemetry.subscribe(object, (datum) => {
                    if (!this.openmct.time.isRealTime() || this.destroyed) return;
                    if (this.loading) {
                        this.queue.push([channel, datum]);
                    } else {
                        this.ingest(channel, datum);
                    }
                }));
            });
            await this.load();
        }

        async load() {
            if (!this.objects || this.destroyed) return;
            const generation = ++this.generation;
            this.loading = true;
            this.queue = [];
            this.refs.error.hidden = true;
            this.refs.loadState.textContent = 'Loading selected window…';
            const bounds = this.openmct.time.getBounds();
            const results = await Promise.allSettled(this.objects.map((object, i) => {
                const channel = this.definition.channels[i];
                const options = { start: bounds.start, end: bounds.end };
                if (channel.raw && this.dashboardKey === 'map-dashboard') options.start -= LOOKBACK;
                if (!channel.raw) Object.assign(options, channel.plot && this.dashboardKey === 'dynamics-dashboard'
                    // Each minmax bucket yields two extrema. Keep buckets
                    // below 750 ms so sampling does not create false >2 s
                    // gaps in the shared strip renderer's usual 15 min view.
                    ? { strategy: 'minmax', size: Math.max(2400, Math.ceil((bounds.end - bounds.start) / 750) * 2) }
                    : { strategy: 'latest', size: 1 });
                return this.openmct.telemetry.request(object, options);
            }));
            if (this.destroyed || generation !== this.generation) return;
            this.rows = {};
            this.latest = {};
            this.seen = {};
            this.logEntries = [];
            this.tracker = new window.StarPiFlight.FlightTracker(window.StarPi.flight.options());
            const merged = [];
            const failed = [];
            results.forEach((result, i) => {
                const channel = this.definition.channels[i];
                if (result.status === 'fulfilled') {
                    result.value.forEach((datum) => merged.push([channel, datum]));
                } else {
                    failed.push(channel.label || channel.key);
                }
            });
            merged.sort((a, b) => a[1].utc - b[1].utc).forEach(([channel, datum]) => this.ingest(channel, datum));
            this.loading = false;
            this.queue.forEach(([channel, datum]) => this.ingest(channel, datum));
            this.queue = [];
            this.dirty = this.logDirty = true;
            if (failed.length) this.showError(`History unavailable for ${failed.join(', ')}. Use Reload window to retry. Live data may still arrive.`);
            this.render();
        }

        ingest(channel, datum) {
            if (!Number.isFinite(datum.utc)) return;
            const key = channel.key;
            // Packet IDs need not follow rocket time (BLE batches are LIFO).
            // Deduplicate history/live overlap by identity, never by ID order.
            this.seen ??= {};
            const seen = this.seen[key] ??= new Set();
            if (Number.isFinite(datum.id)) {
                if (seen.has(datum.id)) return;
                seen.add(datum.id);
                if (seen.size > 20000) seen.delete(seen.values().next().value);
            }
            if (datum.utc >= (this.latest[key]?.utc ?? -Infinity)) this.latest[key] = datum;
            if (channel.plot && this.dashboardKey === 'dynamics-dashboard') {
                const series = this.rows[key] ??= [];
                // Late packets from a slower link must not make a plot double back.
                if (Number.isFinite(datum.value) && datum.utc >= (series.at(-1)?.t ?? -Infinity)) {
                    series.push({ t: datum.utc, v: datum.value });
                    if (series.length > MAX_SERIES) {
                        const compact = [];
                        for (let i = 0; i < series.length; i += 6) {
                            const bucket = series.slice(i, i + 6);
                            const low = bucket.reduce((a, b) => a.v < b.v ? a : b);
                            const high = bucket.reduce((a, b) => a.v > b.v ? a : b);
                            compact.push(...[...new Set([bucket[0], low, high, bucket.at(-1)])].sort((a, b) => a.t - b.t));
                        }
                        this.rows[key] = compact;
                    }
                }
            }
            if (this.dashboardKey === 'map-dashboard' && channel.raw) {
                if (key === 'T_GPS') this.tracker.update({ t: datum.utc, kind: 'gps', lat: datum.lat, lon: datum.lon });
                if (key === 'T_ROCKET_STATE') this.tracker.update({ t: datum.utc, kind: 'state', state: datum.state });
            }
            if (key === 'T_SYSLOG') {
                this.logEntries.push({ utc: datum.utc, message: String(datum.message ?? '') });
                this.logEntries.sort((a, b) => a.utc - b.utc);
                if (this.logEntries.length > MAX_LOG) this.logEntries.splice(0, this.logEntries.length - MAX_LOG);
                this.logDirty = true;
            }
            this.dirty = true;
        }

        showError(message) {
            if (this.destroyed) return;
            this.refs.error.textContent = message;
            this.refs.error.hidden = false;
        }

        render() {
            if (this.destroyed) return;
            const realtime = this.openmct.time.isRealTime();
            const bounds = this.openmct.time.getBounds();
            const { station, stream } = window.StarPi;
            this.refs.mode.textContent = realtime ? 'REAL-TIME' : 'REPLAY';
            const phaseValue = this.latest[phase.key]?.value;
            this.refs.phase.textContent = window.StarPiFlight.PHASE_LABELS[window.StarPiFlight.PHASES[phaseValue]] || '';
            this.refs.connection.textContent = !station.ok ? 'Backend offline' : stream.connected ? 'Stream connected' : 'Stream reconnecting';
            this.refs.connection.className = station.ok && stream.connected ? 'ss-ok' : 'ss-warn';
            for (const channel of this.definition.channels.filter((c) => !c.raw)) {
                const node = this.element.querySelector(`[data-metric="${channel.key}"]`);
                if (!node) continue;
                const datum = this.latest[channel.key];
                const inWindow = datum && datum.utc >= bounds.start && datum.utc <= bounds.end;
                node.textContent = fixed(inWindow ? datum.value : null, channel.digits);
                const stale = realtime && stream.isStale(channel.source);
                node.classList.toggle('ss-stale', Boolean(stale && inWindow));
                node.title = stale ? 'Telemetry is stale: no recent sample from this source.' : '';
            }
            if (realtime) {
                Object.values(this.rows).forEach((series) => {
                    const first = series.findIndex((p) => p.t >= bounds.start);
                    if (first === -1) series.length = 0;
                    else if (first > 0) series.splice(0, first);
                });
                const before = this.logEntries.length;
                this.logEntries = this.logEntries.filter((entry) => entry.utc >= bounds.start && entry.utc <= bounds.end);
                if (before !== this.logEntries.length) this.logDirty = true;
            }
            if (this.dashboardKey === 'dynamics-dashboard' && !this.loading) this.renderPlots(bounds);
            if (this.refs.range && this.tracker) this.renderMap(bounds);
            if (this.refs.log && this.logDirty && !this.paused) this.renderLog();
            if (this.refs.links) this.renderLinks();
            if (this.dashboardKey === 'diagnostics-dashboard') this.renderDiagnostics();
            if (!this.loading && this.objects) this.refs.loadState.textContent = this.dashboardKey === 'diagnostics-dashboard'
                ? 'Live station status' : `${realtime ? 'Following rocket clock' : 'Selected window · UTC'} · ${clock(bounds.start)} – ${clock(bounds.end)}`;
            this.dirty = false;
        }

        renderPlots(bounds) {
            this.element.querySelectorAll('[data-chart]').forEach((canvas) => {
                const series = this.rows[canvas.dataset.chart] || [];
                window.StarPiCharts.drawStrip(canvas, { ...bounds, series, zero: true, floor: 1 });
                const empty = this.element.querySelector(`[data-empty="${canvas.dataset.chart}"]`);
                empty.hidden = series.length > 0;
                empty.textContent = 'No telemetry in this time window.';
            });
        }

        async initMap() {
            this.basemap = new window.StarPiBasemap.Basemap(this.refs.basemap);
            this.mapMode = 'off';
            this.refs.copy.addEventListener('click', async () => {
                const fix = this.tracker?.snapshot().fix;
                if (!fix) return;
                try {
                    await navigator.clipboard.writeText(`${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`);
                    if (!this.destroyed) this.refs.copyResult.textContent = 'Coordinates copied.';
                } catch (_error) {
                    if (!this.destroyed) this.refs.copyResult.textContent = 'Clipboard unavailable. Select the coordinates above to copy them.';
                }
            });
            const site = await window.StarPiBasemap.site();
            if (!site || this.destroyed) return;
            this.refs.mapTools.hidden = false;
            this.refs.mapTools.querySelector('[data-mode="satellite"]').hidden = !site.satellite;
            this.refs.mapTools.addEventListener('click', (event) => {
                const mode = event.target.closest('[data-mode]')?.dataset.mode;
                if (mode) this.setMapMode(mode);
            });
            this.setMapMode('map');
        }

        async setMapMode(mode) {
            this.mapMode = mode;
            this.refs.mapTools.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
            try {
                await this.basemap.setMode(mode);
            } catch (_error) {
                if (this.destroyed) return;
                this.showError('Background map unavailable. The ground track remains available; choose Track only or retry Map.');
                this.setMapMode('off');
            }
            this.dirty = true;
        }

        setValue(key, value) {
            const node = this.element.querySelector(`[data-value="${key}"]`);
            if (node) node.textContent = value;
        }

        renderMap(bounds) {
            const flight = this.tracker.snapshot();
            // Keep the reference from the lookback, but draw only this window.
            const track = flight.track.filter((point) => point.t >= bounds.start && point.t <= bounds.end);
            this.tracker.track = track;
            const drawn = window.StarPiCharts.drawRange(this.refs.range, {
                pad: flight.pad, fix: flight.fix, track, onMap: this.mapMode !== 'off'
            }, window.StarPiFlight.localOffset);
            this.basemap?.view(flight.pad, drawn ? 1 / drawn.scale : null);
            const stale = this.openmct.time.isRealTime() && window.StarPi.stream.isStale('T_GPS');
            this.refs.mapNote.textContent = !flight.fix ? 'Waiting for GPS telemetry.'
                : stale ? 'GPS is stale. Showing the last known position.'
                    : flight.fix.t < bounds.start ? 'No GPS sample in this window. Showing the last known position.'
                        : `${track.length} track points · pad reference from idle GPS fixes; first fix is used if idle data is unavailable.`;
            this.refs.mapNote.classList.toggle('ss-warn', stale);
            this.setValue('distance', flight.fromPad ? `${fixed(flight.fromPad.distance)} m` : '—');
            this.setValue('bearing', flight.fromPad ? `${fixed(flight.fromPad.bearing)}°` : '—');
            this.setValue('lat', fixed(flight.fix?.lat, 6));
            this.setValue('lon', fixed(flight.fix?.lon, 6));
            this.setValue('pad-lat', fixed(flight.pad?.lat, 6));
            this.setValue('pad-lon', fixed(flight.pad?.lon, 6));
            this.setValue('gps-time', flight.fix ? clock(flight.fix.t) : '—');
            this.refs.copy.disabled = !flight.fix;
        }

        initLog() {
            this.refs.search.addEventListener('input', () => this.renderLog());
            this.refs.pause.addEventListener('click', () => {
                this.paused = !this.paused;
                this.refs.pause.setAttribute('aria-pressed', String(this.paused));
                this.refs.pause.textContent = this.paused ? 'Resume display' : 'Pause display';
                if (!this.paused) this.renderLog();
            });
            this.refs.export.addEventListener('click', () => {
                const rows = this.filteredLogs();
                const csv = [['utc', 'message'], ...rows.map((row) => [new Date(row.utc).toISOString(), row.message])]
                    .map((row) => row.map((cell) => {
                        const text = String(cell);
                        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
                        return `"${safe.replace(/"/g, '""')}"`;
                    }).join(',')).join('\r\n');
                const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
                const link = document.createElement('a');
                link.href = url;
                link.download = 'starpi-mission-logs.csv';
                link.click();
                this.downloadUrls ??= [];
                this.downloadUrls.push(url);
            });
        }

        filteredLogs() {
            const query = this.refs.search.value.trim().toLocaleLowerCase();
            return this.displayEntries.filter((entry) => entry.message.toLocaleLowerCase().includes(query)).slice().reverse();
        }

        renderLog() {
            if (!this.paused) this.displayEntries = this.logEntries.slice();
            this.logDirty = false;
            const rows = this.filteredLogs();
            this.refs.log.innerHTML = rows.map((entry) => `<tr><td><time datetime="${new Date(entry.utc).toISOString()}">${clock(entry.utc)}</time></td><td>${escape(entry.message)}</td></tr>`).join('');
            this.refs.logCount.textContent = `${rows.length} shown / ${this.displayEntries.length} buffered${this.paused ? ' · display paused' : ''}`;
            this.refs.logEmpty.hidden = rows.length > 0;
            this.refs.logEmpty.textContent = this.loading ? 'Loading messages…' : this.refs.search.value ? 'No messages match this search.' : 'No text messages in this time window.';
            this.refs.export.disabled = rows.length === 0;
        }

        renderLinks() {
            const { station } = window.StarPi;
            const html = !station.ok ? '<p class="ss-warn">Backend unreachable. Link status unavailable.</p>'
                : !(station.health?.links?.length) ? '<p class="ss-note">No links configured.</p>'
                    : station.health.links.map((link) => `<div class="ss-link"><div class="ss-link-title"><strong>${escape(link.name)}</strong>
                        <span class="${link.connected ? 'ss-ok' : 'ss-warn'}">${link.connected ? 'Connected' : 'Disconnected'}</span></div>
                        ${link.packets !== undefined ? `<dl class="ss-pairs"><div><dt>Packets</dt><dd>${escape(link.packets)}</dd></div></dl>` : ''}
                        ${Number.isFinite(link.rssi_dbm) ? `<p>RSSI <span class="ss-num">${fixed(link.rssi_dbm)} dBm</span></p>` : ''}
                        ${link.armed !== undefined && link.armed !== null ? `<p>Arming <strong>${link.armed ? 'ARMED' : 'DISARMED'}</strong></p>` : ''}
                        ${link.last_error ? `<p class="ss-warn">${escape(link.last_error)}</p>` : ''}</div>`).join('');
            // Do not replace the DOM every frame when health did not change.
            if (html !== this.linksHtml) { this.refs.links.innerHTML = html; this.linksHtml = html; }
        }

        renderDiagnostics() {
            const { station, stream } = window.StarPi;
            const health = station.ok ? station.health : null;
            this.setValue('rate', station.ok ? fixed(stream.packetRate()) : '—');
            for (const [key, source] of [['decode', 'decode_errors'], ['store', 'store_errors'], ['dropped', 'dropped_events']]) {
                this.setValue(key, health ? String(health[source] ?? '—') : '—');
            }
            this.setValue('backend', station.ok ? 'Online' : 'Offline');
            this.setValue('websocket', stream.connected ? 'Connected' : 'Reconnecting');
            this.setValue('storage', health?.storage?.state?.toUpperCase() || '—');
            this.setValue('run', health?.run || '—');
            const rocketTime = health?.rocket_time?.timestamp_us;
            this.setValue('rocket-time', Number.isFinite(rocketTime) ? new Date(rocketTime / 1000).toISOString() : '—');
        }

        destroy() {
            this.destroyed = true;
            this.generation += 1;
            clearInterval(this.timer);
            this.off.forEach((off) => off());
            this.openmct.time.off('boundsChanged', this.onBounds);
            this.openmct.time.off('modeChanged', this.onMode);
            this.openmct.time.off('clockChanged', this.onMode);
            this.resize?.disconnect();
            this.commands?.destroy();
            this.rocket?.destroy();
            this.basemap?.destroy();
            this.downloadUrls?.forEach((url) => URL.revokeObjectURL(url));
        }
    }

    window.StarPiSectors = {
        definitions, navigation, View: SectorView,
        plugin: () => (openmct) => {
            openmct.types.addType(TYPE, { name: 'StarPi dashboard', cssClass: 'icon-layout', description: 'Focused StarPi mission workspace.' });
            openmct.objectViews.addProvider({
                key: 'starpi.sector-view', name: 'Dashboard', cssClass: 'icon-layout',
                canView: (object) => object.type === TYPE,
                view: (object) => new SectorView(openmct, object.identifier.key), priority: () => 1
            });
        }
    };
}());
