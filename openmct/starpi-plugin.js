/*
 * Open MCT plugin for the StarPi ground station backend (backend/src/api.py).
 *
 * Exposes one telemetry object per protocol message type under a "StarPi"
 * root folder. History comes from GET /api/packets, live data from the /ws
 * websocket; both are reached through the same origin (Apache proxies them).
 */
(function () {
    const NAMESPACE = 'starpi';
    const ROOT_KEY = 'root';
    const TELEMETRY_TYPE = 'starpi.telemetry';

    // Upper bound on GET /api/packets?limit=, matches SP_MAX_PAGE_SIZE.
    const PAGE_SIZE = 1000;
    // Stop paging after this many packets per request, so a wide time range
    // cannot freeze the browser.
    const MAX_HISTORY = 50000;

    // Message type -> how its payload maps onto telemetry fields. `from` is the
    // payload key (x/y/z for vectors); scalar payloads use `from: null`.
    const DICTIONARY = {
        T_ALT_SPEED: {
            name: 'Altitude / Speed',
            fields: [
                { key: 'altitude', name: 'Altitude', unit: 'm', from: 'x' },
                { key: 'speed', name: 'Vertical speed', unit: 'm/s', from: 'y' }
            ]
        },
        T_ACCELLERATION: {
            name: 'Acceleration',
            fields: vector('m/s²')
        },
        T_GYRO: {
            name: 'Gyroscope',
            fields: vector('°/s')
        },
        T_ORIENTATION: {
            name: 'Orientation',
            fields: vector('°')
        },
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
        return ['x', 'y', 'z'].map((axis) => ({
            key: axis,
            name: axis.toUpperCase(),
            unit,
            from: axis
        }));
    }

    function toDatum(packet) {
        const spec = DICTIONARY[packet.type];
        const datum = {
            id: packet.id,
            utc: Math.floor(packet.timestamp_us / 1000),
            src: packet.src,
            link: packet.link
        };
        if (!spec) {
            return datum;
        }

        const payload = packet.payload;
        for (const field of spec.fields) {
            if (field.from === null) {
                datum[field.key] = payload;
            } else if (payload && typeof payload === 'object') {
                datum[field.key] = payload[field.from];
            }
        }

        return datum;
    }

    function metadataValues(spec) {
        const values = [
            {
                key: 'utc',
                source: 'utc',
                name: 'Timestamp',
                format: 'utc',
                hints: { domain: 1 }
            }
        ];
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

    // --- live stream -------------------------------------------------------

    /**
     * One websocket shared by every subscription, reconnecting with backoff.
     * Replays are skipped (backfill=0): Open MCT asks for history separately.
     */
    class LiveStream {
        constructor(url) {
            this.url = url;
            this.listeners = new Map(); // message type -> Set<callback>
            this.statusListeners = new Set();
            this.socket = null;
            this.retryDelay = 1000;
            this.retryTimer = null;
            this.status = { connected: false };
        }

        subscribe(type, callback) {
            if (!this.listeners.has(type)) {
                this.listeners.set(type, new Set());
            }
            this.listeners.get(type).add(callback);
            this.connect();

            return () => {
                const callbacks = this.listeners.get(type);
                callbacks.delete(callback);
                if (callbacks.size === 0) {
                    this.listeners.delete(type);
                }
            };
        }

        onStatus(callback) {
            this.statusListeners.add(callback);
            callback(this.status);
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
                this.setStatus({ connected: true });
            };
            socket.onmessage = (message) => this.handle(JSON.parse(message.data));
            socket.onclose = () => {
                this.socket = null;
                this.setStatus({ connected: false });
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    this.connect();
                }, this.retryDelay);
                this.retryDelay = Math.min(this.retryDelay * 2, 30000);
            };
        }

        handle(event) {
            if (event.event === 'packet') {
                const callbacks = this.listeners.get(event.data.type);
                if (callbacks) {
                    const datum = toDatum(event.data);
                    callbacks.forEach((callback) => callback(datum));
                }
            }
        }

        setStatus(status) {
            this.status = status;
            this.statusListeners.forEach((callback) => callback(this.status));
        }
    }

    // --- history -----------------------------------------------------------

    async function fetchPage(apiUrl, params, signal) {
        const response = await fetch(`${apiUrl}/packets?${params}`, { signal });
        if (!response.ok) {
            throw new Error(`GET /api/packets failed: ${response.status}`);
        }

        return response.json();
    }

    async function requestHistory(apiUrl, type, options) {
        const signal = options.signal;

        if (options.strategy === 'latest' && options.size === 1) {
            const params = new URLSearchParams({ type, limit: '1', order: 'desc' });
            if (options.end !== undefined) {
                params.set('until_us', String(Math.floor(options.end * 1000)));
            }
            const page = await fetchPage(apiUrl, params, signal);

            return page.packets.map(toDatum);
        }

        const data = [];
        let offset = 0;
        while (offset < MAX_HISTORY) {
            const params = new URLSearchParams({
                type,
                order: 'asc',
                limit: String(PAGE_SIZE),
                offset: String(offset)
            });
            if (options.start !== undefined) {
                params.set('since_us', String(Math.floor(options.start * 1000)));
            }
            if (options.end !== undefined) {
                params.set('until_us', String(Math.floor(options.end * 1000)));
            }

            const page = await fetchPage(apiUrl, params, signal);
            page.packets.forEach((packet) => data.push(toDatum(packet)));
            offset += page.count;
            if (page.count < PAGE_SIZE || offset >= page.total) {
                break;
            }
        }

        return data;
    }

    // --- status indicator --------------------------------------------------

    // Link state changes without a websocket event (BLE reconnects), so the
    // indicator polls GET /api/links instead of relying on the hello message.
    const LINK_POLL_MS = 5000;

    function installIndicator(openmct, apiUrl, stream) {
        const indicator = openmct.indicators.simpleIndicator();
        indicator.iconClass('icon-connectivity');
        openmct.indicators.add(indicator);

        let links = null;
        let connected = false;

        function render() {
            const up = (links || []).filter((link) => link.connected);
            if (!connected || links === null) {
                indicator.statusClass('s-status-error');
                indicator.text('Backend offline');
            } else if (up.length === 0) {
                indicator.statusClass('s-status-warning');
                indicator.text('No rocket link');
            } else {
                indicator.statusClass('s-status-on');
                indicator.text(`Link up: ${up.map((link) => link.name).join(', ')}`);
            }
            const detail = (links || [])
                .map((link) => `${link.name}: ${link.connected ? 'up' : link.last_error || 'down'}`)
                .join('; ');
            indicator.description(detail || 'StarPi backend');
        }

        async function poll() {
            try {
                const response = await fetch(`${apiUrl}/links`);
                links = response.ok ? (await response.json()).links : null;
            } catch (error) {
                links = null;
            }
            render();
        }

        stream.onStatus((status) => {
            connected = status.connected;
            render();
        });
        poll();
        setInterval(poll, LINK_POLL_MS);
    }

    // --- plugin ------------------------------------------------------------

    window.StarPiPlugin = function StarPiPlugin(config = {}) {
        const apiUrl = config.apiUrl || '/api';
        const wsUrl = config.wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?backfill=0`;

        return function install(openmct) {
            const stream = new LiveStream(wsUrl);

            openmct.objects.addRoot({ namespace: NAMESPACE, key: ROOT_KEY });

            openmct.types.addType(TELEMETRY_TYPE, {
                name: 'StarPi Telemetry',
                description: 'A message type decoded by the StarPi ground station.',
                cssClass: 'icon-telemetry'
            });

            openmct.objects.addProvider(NAMESPACE, {
                get(identifier) {
                    if (identifier.key === ROOT_KEY) {
                        return Promise.resolve({
                            identifier,
                            name: 'StarPi',
                            type: 'folder',
                            location: 'ROOT'
                        });
                    }

                    const spec = DICTIONARY[identifier.key];
                    if (!spec) {
                        return Promise.reject(new Error(`unknown StarPi object ${identifier.key}`));
                    }

                    return Promise.resolve({
                        identifier,
                        name: spec.name,
                        type: TELEMETRY_TYPE,
                        location: `${NAMESPACE}:${ROOT_KEY}`,
                        telemetry: { values: metadataValues(spec) }
                    });
                }
            });

            openmct.composition.addProvider({
                appliesTo(domainObject) {
                    return domainObject.identifier.namespace === NAMESPACE
                        && domainObject.identifier.key === ROOT_KEY;
                },
                load() {
                    return Promise.resolve(
                        Object.keys(DICTIONARY).map((key) => ({ namespace: NAMESPACE, key }))
                    );
                }
            });

            openmct.telemetry.addProvider({
                supportsRequest(domainObject) {
                    return domainObject.type === TELEMETRY_TYPE;
                },
                request(domainObject, options) {
                    return requestHistory(apiUrl, domainObject.identifier.key, options);
                },
                supportsSubscribe(domainObject) {
                    return domainObject.type === TELEMETRY_TYPE;
                },
                subscribe(domainObject, callback) {
                    return stream.subscribe(domainObject.identifier.key, callback);
                }
            });

            installIndicator(openmct, apiUrl, stream);
        };
    };
}());
