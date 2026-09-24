/*
 * Open MCT plugin for the StarPi ground station backend (backend/src/api.py).
 *
 * Follows Open MCT's telemetry conventions: one telemetry object per measured
 * quantity (Altitude, Orientation X, ...) grouped in folders by subsystem, a
 * UTC domain and a single range per object, units in the metadata. That is
 * what lets the standard views (plots, LAD tables, gauges, condition sets)
 * combine them freely.
 *
 * Everything comes from the backend through the same origin (Apache proxies
 * /api and /ws): history from GET /api/packets, live data from the websocket,
 * link health from GET /api/health.
 *
 * Also exposes window.StarPi for the other StarPi scripts (flight estimates,
 * Launch Control, dashboard seeding).
 */
(function () {
    const NAMESPACE = 'starpi';
    const ROOT_KEY = 'root';
    const POINT_TYPE = 'starpi.telemetry';
    // One object per protocol message type, with all its fields. Not in the
    // tree: the Launch Control view reads them directly.
    const MESSAGE_TYPE = 'starpi.message';
    const STATION_TYPE = 'starpi.station';

    // Upper bound on GET /api/packets?limit=, matches SP_MAX_PAGE_SIZE.
    const PAGE_SIZE = 1000;
    // Stop paging after this many packets per request, so a wide time range
    // cannot freeze the browser.
    const MAX_HISTORY = 50000;
    // A telemetry object is stale when its message type has not arrived for this long.
    const STALE_MS = 5000;
    const HEALTH_POLL_MS = 2000;
    const HEALTH_TIMEOUT_MS = 1500;
    const API_TIMEOUT_MS = 8000;

    // --- dictionary ------------------------------------------------------------

    // Every message type and how its payload maps onto fields. `from` is the
    // payload key (x/y/z for vectors); scalar payloads use `from: null`.
    const MESSAGES = {
        T_ALT_SPEED: {
            name: 'Altitude / Speed',
            fields: [
                { key: 'altitude', name: 'Altitude', unit: 'm', from: 'x' },
                { key: 'speed', name: 'Vertical speed', unit: 'm/s', from: 'y' }
            ]
        },
        T_ACCELLERATION: { name: 'Acceleration', fields: vector('m/s²') },
        T_GYRO: { name: 'Gyroscope', fields: vector('°/s') },
        T_ORIENTATION: { name: 'Orientation', fields: vector('°') },
        T_PRESSURE: {
            name: 'Pressure',
            fields: [{ key: 'value', name: 'Pressure', unit: 'hPa', from: null }]
        },
        T_TEMPERATURE: {
            name: 'Temperature',
            fields: [{ key: 'value', name: 'Temperature', unit: '°C', from: null }]
        },
        T_GPS: {
            name: 'GPS',
            fields: [
                { key: 'lat', name: 'Latitude', unit: '°', from: 'x' },
                { key: 'lon', name: 'Longitude', unit: '°', from: 'y' }
            ]
        },
        T_SYSLOG: {
            name: 'System log',
            fields: [{ key: 'message', name: 'Message', from: null, format: 'string' }]
        }
    };

    function vector(unit) {
        return ['x', 'y', 'z'].map((axis) => ({ key: axis, name: axis.toUpperCase(), unit, from: axis }));
    }

    // Telemetry points: one measured quantity each.
    const POINTS = {
        'baro.altitude': { name: 'Altitude (MSL)', message: 'T_ALT_SPEED', from: 'x', unit: 'm', precision: 1 },
        'baro.speed': { name: 'Vertical speed', message: 'T_ALT_SPEED', from: 'y', unit: 'm/s', precision: 1 },
        'baro.pressure': { name: 'Pressure', message: 'T_PRESSURE', from: null, unit: 'hPa', precision: 2 },
        'baro.temperature': { name: 'Temperature', message: 'T_TEMPERATURE', from: null, unit: '°C', precision: 1 },
        'gps.lat': { name: 'Latitude', message: 'T_GPS', from: 'x', unit: '°', precision: 6 },
        'gps.lon': { name: 'Longitude', message: 'T_GPS', from: 'y', unit: '°', precision: 6 },
        'sys.log': { name: 'System log', message: 'T_SYSLOG', from: null, format: 'string' }
    };
    for (const [group, name, message, unit, precision] of [
        ['accel', 'Acceleration', 'T_ACCELLERATION', 'm/s²', 2],
        ['gyro', 'Angular rate', 'T_GYRO', '°/s', 1],
        ['orientation', 'Orientation', 'T_ORIENTATION', '°', 1]
    ]) {
        for (const axis of ['x', 'y', 'z']) {
            POINTS[`imu.${group}.${axis}`] = {
                name: `${name} ${axis.toUpperCase()}`, message, from: axis, unit, precision
            };
        }
    }

    // Ground station health, polled from GET /api/health.
    const STATION = {
        'station.link': {
            name: 'Rocket link',
            format: 'enum',
            enumerations: [
                { value: 0, string: 'OFFLINE' },
                { value: 1, string: 'DOWN' },
                { value: 2, string: 'UP' }
            ]
        },
        'station.rate': { name: 'Packet rate', unit: 'pkt/s', precision: 0 },
        'station.errors': { name: 'Errors', precision: 0 },
        'station.dropped': { name: 'Dropped events', precision: 0 }
    };

    // Folder tree. The flight folder's children come from flight-service.js.
    const FOLDERS = {
        root: {
            name: 'StarPi',
            children: ['launch-control', 'commands', 'flight', 'baro', 'imu', 'gps', 'station', 'sys.log']
        },
        baro: { name: 'Barometer', children: ['baro.altitude', 'baro.speed', 'baro.pressure', 'baro.temperature'] },
        imu: { name: 'IMU', children: ['imu.accel', 'imu.gyro', 'imu.orientation'] },
        'imu.accel': { name: 'Acceleration', plot: true, children: ['imu.accel.x', 'imu.accel.y', 'imu.accel.z'] },
        'imu.gyro': { name: 'Angular rate', plot: true, children: ['imu.gyro.x', 'imu.gyro.y', 'imu.gyro.z'] },
        'imu.orientation': {
            name: 'Orientation',
            plot: true,
            children: ['imu.orientation.x', 'imu.orientation.y', 'imu.orientation.z']
        },
        gps: { name: 'GPS', children: ['gps.lat', 'gps.lon'] },
        station: { name: 'Ground station', children: Object.keys(STATION) }
    };

    const DOMAIN = { key: 'utc', source: 'utc', name: 'Timestamp', format: 'utc', hints: { domain: 1 } };

    /** Metadata for a single-value telemetry object. */
    function valueMetadata(spec) {
        const value = {
            key: 'value',
            name: spec.name,
            format: spec.format || 'float',
            hints: spec.format === 'string' ? {} : { range: 1 }
        };
        if (spec.unit) {
            value.unit = spec.unit;
        }
        if (spec.enumerations) {
            value.enumerations = spec.enumerations;
        }
        if (spec.precision !== undefined) {
            value.formatString = `%0.${spec.precision}f`;
        }

        return [DOMAIN, value];
    }

    function messageMetadata(spec) {
        const values = [DOMAIN];
        spec.fields.forEach((field, index) => {
            const value = {
                key: field.key,
                name: field.name,
                format: field.format || 'float',
                hints: field.format === 'string' ? {} : { range: index + 1 }
            };
            if (field.unit) {
                value.unit = field.unit;
            }
            values.push(value);
        });
        values.push(
            { key: 'src', name: 'Source', format: 'string' },
            { key: 'link', name: 'Link', format: 'string' }
        );

        return values;
    }

    function pick(payload, from) {
        if (from === null) {
            return payload;
        }

        return payload && typeof payload === 'object' ? payload[from] : undefined;
    }

    function pointDatum(spec, packet) {
        return { utc: Math.floor(packet.timestamp_us / 1000), value: pick(packet.payload, spec.from) };
    }

    function messageDatum(packet) {
        const spec = MESSAGES[packet.type];
        const datum = {
            id: packet.id,
            utc: Math.floor(packet.timestamp_us / 1000),
            src: packet.src,
            link: packet.link
        };
        for (const field of spec ? spec.fields : []) {
            datum[field.key] = pick(packet.payload, field.from);
        }

        return datum;
    }

    // --- backend access ----------------------------------------------------------

    /** JSON call with a deadline: a stopped backend can keep Apache waiting for tens of seconds. */
    async function api(path, options = {}, timeoutMs = API_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(`/api${path}`, { ...options, signal: controller.signal });
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

    function micros(ms) {
        return String(Math.floor(ms * 1000));
    }

    async function fetchRange(type, start, end) {
        const packets = [];
        let offset = 0;
        while (offset < MAX_HISTORY) {
            const params = new URLSearchParams({ type, order: 'asc', limit: String(PAGE_SIZE), offset: String(offset) });
            if (start !== undefined) {
                params.set('since_us', micros(start));
            }
            if (end !== undefined) {
                params.set('until_us', micros(end));
            }
            const page = await api(`/packets?${params}`);
            packets.push(...page.packets);
            offset += page.count;
            if (page.count < PAGE_SIZE || offset >= page.total) {
                break;
            }
        }

        return packets;
    }

    async function fetchLatest(type, end) {
        const params = new URLSearchParams({ type, limit: '1', order: 'desc' });
        if (end !== undefined) {
            params.set('until_us', micros(end));
        }

        return (await api(`/packets?${params}`)).packets;
    }

    // Several objects share a message type (Orientation X/Y/Z, a plot and a
    // LAD table on the same layout...): identical concurrent requests share one fetch.
    const inflight = new Map();

    function fetchPackets(type, options) {
        const latest = options.strategy === 'latest' && options.size === 1;
        const key = `${type}|${options.start}|${options.end}|${latest}`;
        if (!inflight.has(key)) {
            const request = (latest ? fetchLatest(type, options.end) : fetchRange(type, options.start, options.end))
                .finally(() => inflight.delete(key));
            inflight.set(key, request);
        }

        return inflight.get(key);
    }

    // --- live stream -------------------------------------------------------------

    /**
     * One websocket shared by every subscription, reconnecting with backoff.
     * Replays are skipped (backfill=0): Open MCT asks for history separately.
     * Also tracks when each message type last arrived, for staleness.
     */
    class LiveStream {
        constructor(url) {
            this.url = url;
            this.listeners = new Map(); // message type -> Set<callback(packet)>
            this.statusListeners = new Set();
            this.lastSeen = new Map(); // message type -> receive time (ms)
            this.received = []; // receive times over the last 5 s, for the packet rate
            this.socket = null;
            this.retryDelay = 1000;
            this.retryTimer = null;
            this.connected = false;
        }

        subscribe(type, callback) {
            if (!this.listeners.has(type)) {
                this.listeners.set(type, new Set());
            }
            this.listeners.get(type).add(callback);
            this.connect();

            return () => {
                const callbacks = this.listeners.get(type);
                callbacks?.delete(callback);
                if (callbacks?.size === 0) {
                    this.listeners.delete(type);
                }
            };
        }

        onStatus(callback) {
            this.statusListeners.add(callback);
            callback(this.connected);
            this.connect();
        }

        connect() {
            if (this.socket || this.retryTimer) {
                return;
            }

            const socket = new WebSocket(this.url);
            this.socket = socket;

            socket.onopen = () => {
                this.retryDelay = 1000;
                this.setConnected(true);
            };
            socket.onmessage = (message) => this.handle(JSON.parse(message.data));
            socket.onclose = () => {
                this.socket = null;
                this.setConnected(false);
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    this.connect();
                }, this.retryDelay);
                this.retryDelay = Math.min(this.retryDelay * 2, 30000);
            };
        }

        handle(event) {
            if (event.event !== 'packet') {
                return;
            }
            const packet = event.data;
            const now = Date.now();
            this.lastSeen.set(packet.type, now);
            this.received.push(now);
            this.listeners.get(packet.type)?.forEach((callback) => callback(packet));
        }

        packetRate() {
            const cutoff = Date.now() - 5000;
            while (this.received.length && this.received[0] < cutoff) {
                this.received.shift();
            }

            return this.received.length / 5;
        }

        isStale(type) {
            const seen = this.lastSeen.get(type);

            return seen === undefined || Date.now() - seen > STALE_MS;
        }

        setConnected(connected) {
            this.connected = connected;
            this.statusListeners.forEach((callback) => callback(connected));
        }
    }

    /** Standard Open MCT staleness for objects fed by a message type. */
    class StalenessWatcher {
        constructor(stream) {
            this.stream = stream;
            this.watchers = new Set(); // { type, callback, stale }
            this.timer = null;
        }

        subscribe(type, callback) {
            const watcher = { type, callback, stale: undefined };
            this.watchers.add(watcher);
            this.check(watcher);
            this.timer ??= setInterval(() => this.watchers.forEach((w) => this.check(w)), 1000);

            return () => {
                this.watchers.delete(watcher);
                if (!this.watchers.size) {
                    clearInterval(this.timer);
                    this.timer = null;
                }
            };
        }

        check(watcher) {
            const stale = this.stream.isStale(watcher.type);
            if (stale !== watcher.stale) {
                watcher.stale = stale;
                watcher.callback({ isStale: stale, timestamp: Date.now() });
            }
        }
    }

    // --- ground station health -----------------------------------------------------

    /** Polls /api/health and turns it into the station.* telemetry objects. */
    class Station {
        constructor(stream) {
            this.stream = stream;
            this.listeners = new Map(); // key -> Set<callback>
            this.statusListeners = new Set();
            this.health = null;
            this.ok = false;
            this.polled = false;
            this.polling = false;
        }

        start() {
            this.poll();
            setInterval(() => this.poll(), HEALTH_POLL_MS);
        }

        async poll() {
            if (this.polling) {
                return;
            }
            this.polling = true;
            try {
                this.health = await api('/health', {}, HEALTH_TIMEOUT_MS);
                this.ok = true;
            } catch (error) {
                this.ok = false;
            } finally {
                this.polling = false;
                this.polled = true;
            }
            this.emit();
        }

        values() {
            const links = this.health?.links ?? [];
            const up = links.some((link) => link.connected);

            return {
                'station.link': !this.ok ? 0 : up ? 2 : 1,
                'station.rate': this.stream.packetRate(),
                'station.errors': this.health ? this.health.decode_errors + this.health.store_errors : undefined,
                'station.dropped': this.health?.dropped_events
            };
        }

        latest(key) {
            return this.polled ? [{ utc: Date.now(), value: this.values()[key] }] : [];
        }

        subscribe(key, callback) {
            if (!this.listeners.has(key)) {
                this.listeners.set(key, new Set());
            }
            this.listeners.get(key).add(callback);

            return () => this.listeners.get(key).delete(callback);
        }

        onStatus(callback) {
            this.statusListeners.add(callback);

            return () => this.statusListeners.delete(callback);
        }

        emit() {
            const utc = Date.now();
            const values = this.values();
            for (const [key, callbacks] of this.listeners) {
                callbacks.forEach((callback) => callback({ utc, value: values[key] }));
            }
            this.statusListeners.forEach((callback) => callback(this));
        }
    }

    // --- formats -------------------------------------------------------------------

    /** Seconds since launch as "T+ mm:ss.s". */
    const MISSION_TIME_FORMAT = {
        key: 'starpi.mission-time',
        format(value) {
            if (!Number.isFinite(value)) {
                return 'T+ --:--.-';
            }
            const minutes = Math.floor(value / 60);
            const seconds = value - minutes * 60;

            return `T+ ${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
        },
        parse(text) {
            return Number(text);
        },
        validate() {
            return true;
        }
    };

    // --- status indicator ------------------------------------------------------------

    function installIndicator(openmct, station, stream) {
        const indicator = openmct.indicators.simpleIndicator();
        indicator.iconClass('icon-connectivity');
        openmct.indicators.add(indicator);

        const render = () => {
            const links = station.health?.links ?? [];
            const up = links.filter((link) => link.connected);
            if (!station.ok || !stream.connected) {
                indicator.statusClass('s-status-error');
                indicator.text('Backend offline');
            } else if (!up.length) {
                indicator.statusClass('s-status-warning');
                indicator.text('No rocket link');
            } else {
                indicator.statusClass('s-status-on');
                indicator.text(`Link up: ${up.map((link) => link.name).join(', ')}`);
            }
            const detail = links
                .map((link) => `${link.name}: ${link.connected ? 'up' : link.last_error || 'down'}`)
                .join('; ');
            indicator.description(detail || 'StarPi backend');
        };

        station.onStatus(render);
        stream.onStatus(render);
    }

    // --- plugin ----------------------------------------------------------------------

    const stream = new LiveStream(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?backfill=0`);
    const staleness = new StalenessWatcher(stream);
    const station = new Station(stream);

    window.StarPi = {
        NAMESPACE,
        MESSAGES,
        POINTS,
        api,
        fetchPackets,
        fetchRange,
        stream,
        staleness,
        station,
        messageDatum
    };

    window.StarPiPlugin = function StarPiPlugin() {
        return function install(openmct) {
            const flight = new window.StarPiFlightService(openmct);
            window.StarPi.flight = flight;
            FOLDERS.flight = { name: 'Flight (estimated)', children: Object.keys(flight.points) };

            openmct.telemetry.addFormat(MISSION_TIME_FORMAT);
            openmct.objects.addRoot({ namespace: NAMESPACE, key: ROOT_KEY });

            openmct.types.addType(POINT_TYPE, {
                name: 'StarPi Telemetry',
                description: 'A quantity measured by the StarPi rocket.',
                cssClass: 'icon-telemetry'
            });
            openmct.types.addType(MESSAGE_TYPE, {
                name: 'StarPi Message',
                description: 'Every field of one StarPi protocol message type.',
                cssClass: 'icon-telemetry'
            });
            openmct.types.addType(STATION_TYPE, {
                name: 'Ground Station Telemetry',
                description: 'Health of the ground station and its link to the rocket.',
                cssClass: 'icon-telemetry'
            });

            const parentOf = (key) => Object.keys(FOLDERS).find((folder) => FOLDERS[folder].children.includes(key));

            openmct.objects.addProvider(NAMESPACE, {
                get(identifier) {
                    const key = identifier.key;
                    const parent = parentOf(key);
                    const base = { identifier, location: parent ? `${NAMESPACE}:${parent}` : 'ROOT' };

                    if (FOLDERS[key]?.plot) {
                        // A vector (X/Y/Z): opens as the three axes overlaid, expands to each axis.
                        return Promise.resolve({
                            ...base,
                            name: FOLDERS[key].name,
                            type: 'telemetry.plot.overlay',
                            // Series pre-filled: the plot would otherwise try to
                            // save them into this read-only object.
                            configuration: {
                                series: FOLDERS[key].children.map((child) => ({
                                    identifier: { namespace: NAMESPACE, key: child }
                                })),
                                yAxis: {},
                                xAxis: {}
                            }
                        });
                    }
                    if (FOLDERS[key]) {
                        return Promise.resolve({ ...base, name: FOLDERS[key].name, type: 'folder' });
                    }
                    if (key === 'launch-control') {
                        return Promise.resolve({ ...base, name: 'Launch Control', type: 'starpi.launch-control' });
                    }
                    if (key === 'commands') {
                        return Promise.resolve({ ...base, name: 'Commands', type: 'starpi.commands' });
                    }

                    const [spec, type, values] = POINTS[key] ? [POINTS[key], POINT_TYPE, valueMetadata(POINTS[key])]
                        : STATION[key] ? [STATION[key], STATION_TYPE, valueMetadata(STATION[key])]
                            : flight.points[key] ? [flight.points[key], flight.type, flight.metadata(key)]
                                : MESSAGES[key] ? [MESSAGES[key], MESSAGE_TYPE, messageMetadata(MESSAGES[key])]
                                    : [];
                    if (!spec) {
                        return Promise.reject(new Error(`unknown StarPi object ${key}`));
                    }

                    return Promise.resolve({ ...base, name: spec.name, type, telemetry: { values } });
                }
            });

            openmct.composition.addProvider({
                appliesTo(domainObject) {
                    return domainObject.identifier.namespace === NAMESPACE
                        && Boolean(FOLDERS[domainObject.identifier.key]);
                },
                load(domainObject) {
                    return Promise.resolve(
                        FOLDERS[domainObject.identifier.key].children.map((key) => ({ namespace: NAMESPACE, key }))
                    );
                }
            });

            const is = (type) => (domainObject) => domainObject.type === type;

            // Measured quantities.
            openmct.telemetry.addProvider({
                supportsRequest: is(POINT_TYPE),
                async request(domainObject, options) {
                    const spec = POINTS[domainObject.identifier.key];
                    const packets = await fetchPackets(spec.message, options);

                    return packets.map((packet) => pointDatum(spec, packet));
                },
                supportsSubscribe: is(POINT_TYPE),
                subscribe(domainObject, callback) {
                    const spec = POINTS[domainObject.identifier.key];

                    return stream.subscribe(spec.message, (packet) => callback(pointDatum(spec, packet)));
                },
                supportsStaleness: is(POINT_TYPE),
                isStale(domainObject) {
                    const spec = POINTS[domainObject.identifier.key];

                    return Promise.resolve({ isStale: stream.isStale(spec.message), timestamp: Date.now() });
                },
                subscribeToStaleness(domainObject, callback) {
                    return staleness.subscribe(POINTS[domainObject.identifier.key].message, callback);
                }
            });

            // Whole messages, for Launch Control.
            openmct.telemetry.addProvider({
                supportsRequest: is(MESSAGE_TYPE),
                async request(domainObject, options) {
                    const packets = await fetchPackets(domainObject.identifier.key, options);

                    return packets.map(messageDatum);
                },
                supportsSubscribe: is(MESSAGE_TYPE),
                subscribe(domainObject, callback) {
                    return stream.subscribe(domainObject.identifier.key, (packet) => callback(messageDatum(packet)));
                }
            });

            // Ground station health: live only, the backend keeps no history of it.
            openmct.telemetry.addProvider({
                supportsRequest: is(STATION_TYPE),
                request(domainObject, options) {
                    return Promise.resolve(
                        options.strategy === 'latest' ? station.latest(domainObject.identifier.key) : []
                    );
                },
                supportsSubscribe: is(STATION_TYPE),
                subscribe(domainObject, callback) {
                    return station.subscribe(domainObject.identifier.key, callback);
                }
            });

            // Flight estimates (flight/flight-service.js).
            openmct.telemetry.addProvider({
                supportsRequest: is(flight.type),
                request(domainObject, options) {
                    return flight.request(domainObject.identifier.key, options);
                },
                supportsSubscribe: is(flight.type),
                subscribe(domainObject, callback) {
                    return flight.subscribe(domainObject.identifier.key, callback);
                },
                supportsStaleness: is(flight.type),
                isStale() {
                    return Promise.resolve({ isStale: stream.isStale('T_ALT_SPEED'), timestamp: Date.now() });
                },
                subscribeToStaleness(domainObject, callback) {
                    return staleness.subscribe('T_ALT_SPEED', callback);
                }
            });

            station.start();
            flight.start();
            installIndicator(openmct, station, stream);
        };
    };
}());
