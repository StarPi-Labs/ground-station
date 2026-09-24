/*
 * The standard-component flight dashboard, created in My Items on first run.
 *
 * Everything here is a stock Open MCT object - Display Layout, Condition Sets
 * and Condition Widgets, Stacked/Overlay/Scatter plots, Gauge, LAD tables, a
 * Telemetry Table - built with each type's own initialize() and saved to the
 * user's persistence, so it can be edited, restyled and recalibrated from the
 * UI like anything made by hand. The only custom pieces it embeds are the
 * StarPi telemetry itself and the Commands panel.
 *
 * Seeding happens once: when the "StarPi Flight Dashboard" folder is missing.
 * Deleting that folder and reloading restores the original.
 */
(function () {
    const FOLDER_KEY = 'starpi-dashboard';
    const LAYOUT_KEY = 'starpi-flight-dashboard';
    const MY_ITEMS = { namespace: '', key: 'mine' };

    const sp = (key) => ({ namespace: 'starpi', key });
    const mine = (key) => ({ namespace: '', key });

    // Colours for condition styles: state only, readable on the dark theme.
    const STYLE = {
        neutral: { backgroundColor: '#3a3f47', color: '#e8eaed' },
        active: { backgroundColor: '#f2a93b', color: '#15171a' },
        apogee: { backgroundColor: '#8ed1fc', color: '#15171a' },
        descent: { backgroundColor: '#4a90d9', color: '#ffffff' },
        ok: { backgroundColor: '#2e7d4f', color: '#ffffff' },
        warn: { backgroundColor: '#f2c12e', color: '#15171a' },
        alarm: { backgroundColor: '#e0423b', color: '#ffffff' }
    };

    function create(openmct, type, key, name, location, extra = {}) {
        const domainObject = {
            identifier: mine(key),
            type,
            name,
            location: openmct.objects.makeKeyString(location)
        };
        openmct.types.get(type).definition.initialize?.(domainObject);
        for (const [field, value] of Object.entries(extra)) {
            domainObject[field] = field === 'configuration'
                ? { ...domainObject.configuration, ...value }
                : value;
        }

        return domainObject;
    }

    function condition(id, output, criteria, trigger = 'all') {
        return {
            isDefault: false,
            id,
            configuration: { name: output, output, trigger, criteria },
            summary: ''
        };
    }

    function criterion(id, telemetry, operation, input, metadata = 'value') {
        return { id, telemetry, operation, input, metadata };
    }

    function defaultCondition(id, output) {
        return {
            isDefault: true,
            id,
            configuration: { name: 'Default', output, trigger: 'all', criteria: [] },
            summary: 'Default condition'
        };
    }

    /** objectStyles for an object styled by a condition set. */
    function conditionalStyles(conditionSet, styles) {
        const conditions = conditionSet.configuration.conditionCollection;
        const fallback = conditions.find((c) => c.isDefault);

        return {
            conditionSetIdentifier: conditionSet.identifier,
            selectedConditionId: fallback.id,
            defaultConditionId: fallback.id,
            styles: conditions.map((c) => ({
                conditionId: c.id,
                style: { border: '', ...styles[c.id], output: c.configuration.output }
            }))
        };
    }

    function build(openmct) {
        const folder = mine(FOLDER_KEY);
        const objects = [];
        const add = (...args) => {
            const domainObject = create(openmct, ...args);
            objects.push(domainObject);

            return domainObject;
        };
        const { PHASES } = window.StarPiFlight;
        const phaseIndex = (phase) => String(PHASES.indexOf(phase));

        // --- settings --------------------------------------------------------
        add(window.StarPiFlightService.SETTINGS_TYPE, 'starpi-flight-settings', 'Flight settings', folder);

        // --- condition sets --------------------------------------------------
        const phaseSet = add('conditionSet', 'starpi-cs-phase', 'Flight phase conditions', folder, {
            composition: [sp('flight.phase')],
            configuration: {
                conditionCollection: [
                    ...PHASES.map((phase) => condition(
                        `phase-${phase}`,
                        phase,
                        [criterion(`phase-${phase}-c`, sp('flight.phase'), 'enumValueIs', [phaseIndex(phase)])]
                    )),
                    defaultCondition('phase-default', 'NO DATA')
                ]
            }
        });

        const alarmSet = add('conditionSet', 'starpi-cs-alarm', 'Alarm conditions', folder, {
            composition: [sp('station.link'), sp('baro.altitude'), sp('flight.phase'), sp('baro.speed')],
            configuration: {
                conditionCollection: [
                    condition('alarm-offline', 'BACKEND OFFLINE', [
                        criterion('alarm-offline-c', sp('station.link'), 'enumValueIs', ['0'])
                    ]),
                    condition('alarm-link', 'NO ROCKET LINK', [
                        criterion('alarm-link-c', sp('station.link'), 'enumValueIs', ['1'])
                    ]),
                    condition('alarm-stale', 'NO TELEMETRY FOR 5 S', [
                        criterion('alarm-stale-c', sp('baro.altitude'), 'isStale', ['5'], 'dataReceived')
                    ]),
                    // Faster than the drogue allows: recovery may have failed.
                    condition('alarm-descent', 'DESCENT TOO FAST', [
                        criterion('alarm-descent-phase', sp('flight.phase'), 'enumValueIs', [phaseIndex('DESCENT')]),
                        criterion('alarm-descent-speed', sp('baro.speed'), 'lessThan', ['-35'])
                    ]),
                    defaultCondition('alarm-default', 'NOMINAL')
                ]
            }
        });

        // --- condition widgets -----------------------------------------------
        const phaseStyles = {
            'phase-PAD': STYLE.neutral,
            'phase-BOOST': STYLE.active,
            'phase-COAST': STYLE.active,
            'phase-APOGEE': STYLE.apogee,
            'phase-DESCENT': STYLE.descent,
            'phase-LANDED': STYLE.ok,
            'phase-default': STYLE.neutral
        };
        const phaseWidget = add('conditionWidget', 'starpi-w-phase', 'Flight phase', folder, {
            label: 'Flight phase',
            configuration: {
                useConditionSetOutputAsLabel: true,
                objectStyles: conditionalStyles(phaseSet, phaseStyles)
            }
        });

        const alarmWidget = add('conditionWidget', 'starpi-w-alarm', 'Alarms', folder, {
            label: 'Alarms',
            configuration: {
                useConditionSetOutputAsLabel: true,
                objectStyles: conditionalStyles(alarmSet, {
                    'alarm-offline': STYLE.alarm,
                    'alarm-link': STYLE.alarm,
                    'alarm-stale': STYLE.warn,
                    'alarm-descent': STYLE.alarm,
                    'alarm-default': STYLE.ok
                })
            }
        });

        // --- plots, gauge, tables ----------------------------------------------
        const flightPlot = add('telemetry.plot.stacked', 'starpi-plot-flight', 'Flight profile', folder, {
            composition: [sp('flight.agl'), sp('baro.speed'), sp('flight.accel')]
        });
        const orientationPlot = add('telemetry.plot.overlay', 'starpi-plot-orientation', 'Orientation', folder, {
            composition: [sp('imu.orientation.x'), sp('imu.orientation.y'), sp('imu.orientation.z')]
        });
        const gyroPlot = add('telemetry.plot.overlay', 'starpi-plot-gyro', 'Angular rate', folder, {
            composition: [sp('imu.gyro.x'), sp('imu.gyro.y'), sp('imu.gyro.z')]
        });
        const track = add('telemetry.plot.scatter-plot', 'starpi-track', 'Ground track (m from pad)', folder, {
            composition: [sp('flight.track')],
            configuration: { axes: { xKey: 'east', yKey: 'north' } }
        });
        const gauge = add('gauge', 'starpi-gauge-altitude', 'Altitude above ground', folder, {
            composition: [sp('flight.agl')],
            configuration: {
                gaugeController: {
                    gaugeType: 'dial-filled',
                    isDisplayMinMax: true,
                    isDisplayCurVal: true,
                    isDisplayUnits: true,
                    isUseTelemetryLimits: false,
                    limitLow: '',
                    limitHigh: '',
                    min: 0,
                    max: 3500,
                    precision: 0
                }
            }
        });
        // LAD tables: name, value, units; the timestamp and type columns only crowd them.
        const lad = { hiddenColumns: { timestamp: true, type: true } };
        const records = add('LadTable', 'starpi-lad-records', 'Flight records', folder, {
            composition: [sp('flight.apogee'), sp('flight.max-speed'), sp('flight.max-accel')],
            configuration: lad
        });
        const position = add('LadTable', 'starpi-lad-position', 'Position', folder, {
            composition: [sp('flight.distance'), sp('flight.bearing'), sp('gps.lat'), sp('gps.lon')],
            configuration: lad
        });
        const environment = add('LadTable', 'starpi-lad-environment', 'Environment', folder, {
            composition: [sp('baro.pressure'), sp('baro.temperature'), sp('flight.ground')],
            configuration: lad
        });
        const log = add('table', 'starpi-log', 'System log', folder, {
            composition: [sp('sys.log')],
            configuration: { hiddenColumns: { name: true } }
        });

        // --- the layout ----------------------------------------------------------
        // Grid units of 10 px; sized for ~1400 x 850 px.
        const items = [];
        const composition = [];
        const place = (item) => {
            items.push({ stroke: '', fill: '', color: '', font: 'default', fontSize: 'default', ...item });
            if (item.identifier && !composition.some((id) => id.key === item.identifier.key && id.namespace === item.identifier.namespace)) {
                composition.push(item.identifier);
            }
        };
        const object = (id, domainObject, x, y, width, height, extra = {}) => place({
            type: 'subobject-view', id, identifier: domainObject.identifier, x, y, width, height, hasFrame: true, ...extra
        });
        const value = (id, key, x, y, width, height, fontSize, displayMode = 'value') => place({
            type: 'telemetry-view', id, identifier: sp(key), x, y, width, height, displayMode, value: 'value', fontSize
        });
        const label = (id, text, x, y, width) => place({
            type: 'text-view', id, text, x, y, width, height: 3, fontSize: '13'
        });

        // Top: phase, mission time, alarms, link.
        object('i-phase', phaseWidget, 0, 0, 28, 7, { hasFrame: false, fontSize: '28' });
        value('i-mission-time', 'flight.mission-time', 29, 0, 26, 7, '36');
        object('i-alarm', alarmWidget, 56, 0, 44, 7, { hasFrame: false, fontSize: '24' });
        value('i-link', 'station.link', 101, 0, 20, 3, '14', 'all');
        value('i-rate', 'station.rate', 101, 4, 20, 3, '14', 'all');
        value('i-errors', 'station.errors', 122, 0, 18, 3, '14', 'all');
        value('i-dropped', 'station.dropped', 122, 4, 18, 3, '14', 'all');

        // Left: the numbers that matter, and the records.
        label('i-agl-label', 'Altitude above ground (m)', 0, 9, 34);
        value('i-agl', 'flight.agl', 0, 12, 34, 9, '72');
        label('i-speed-label', 'Vertical speed (m/s)', 0, 22, 34);
        value('i-speed', 'baro.speed', 0, 25, 34, 5, '36');
        label('i-accel-label', 'Acceleration, total (g)', 0, 31, 34);
        value('i-accel', 'flight.accel', 0, 34, 34, 5, '36');
        object('i-records', records, 0, 40, 34, 10);

        // Centre: flight profile. Right: ground track and position.
        object('i-flight-plot', flightPlot, 35, 9, 70, 41);
        object('i-track', track, 106, 9, 34, 25);
        object('i-position', position, 106, 35, 34, 15);

        // Bottom: attitude, altitude gauge and environment, log, commands.
        object('i-orientation', orientationPlot, 0, 51, 45, 17);
        object('i-gyro', gyroPlot, 0, 69, 45, 16);
        object('i-gauge', gauge, 46, 51, 24, 18);
        object('i-environment', environment, 46, 70, 24, 15);
        object('i-log', log, 71, 51, 38, 34);
        object('i-commands', { identifier: sp('commands') }, 110, 51, 30, 34);

        const layout = add('layout', LAYOUT_KEY, 'Flight Dashboard', folder, {
            composition,
            configuration: { items, layoutGrid: [10, 10] }
        });

        const folderObject = create(openmct, 'folder', FOLDER_KEY, 'StarPi Flight Dashboard', MY_ITEMS, {
            composition: [layout, ...objects.filter((o) => o !== layout)].map((o) => o.identifier)
        });

        return { folderObject, objects };
    }

    async function seed(openmct) {
        // Look in My Items rather than get() the folder: a failed get() raises
        // a "Failed to retrieve object" notification on every first run.
        const myItems = await openmct.objects.get(MY_ITEMS);
        const children = await openmct.composition.get(myItems).load();
        if (children.some((child) => child.identifier.key === FOLDER_KEY)) {
            return false;
        }
        const { folderObject, objects } = build(openmct);
        for (const domainObject of objects) {
            await openmct.objects.save(domainObject);
        }
        await openmct.objects.save(folderObject);
        openmct.composition.get(myItems).add(folderObject);

        return true;
    }

    window.StarPiDashboard = {
        PATH: `#/browse/mine/${FOLDER_KEY}/${LAYOUT_KEY}`,
        seed
    };
}());
