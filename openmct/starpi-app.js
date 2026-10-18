const openmct = window.openmct;

(function () {
    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    // Real-time windows end a little in the future: views that drop data
    // newer than the window's end (gauges, LAD tables) would otherwise miss
    // fresh packets between two clock ticks, or the ones that arrive before
    // the rocket clock has caught up with them.
    const LEAD = 5 * 1000;

    openmct.setAssetPath('/node_modules/openmct/dist');

    // Layouts, notebooks and "My Items" live in the browser's local storage:
    // there is no CouchDB in this deployment.
    openmct.install(openmct.plugins.LocalStorage());
    openmct.install(window.StarPiTheme.plugin());
    openmct.install(window.StarPiBrand.plugin());
    openmct.install(openmct.plugins.MyItems());
    openmct.install(openmct.plugins.UTCTimeSystem());
    // Real-time follows the rocket's clock (starpi-plugin.js), not this
    // machine's: GPS may never set the rocket's. Registered before the
    // conductor, which checks its clocks on install.
    openmct.time.addClock(window.StarPi.clock);
    openmct.install(openmct.plugins.TelemetryMean());
    openmct.install(openmct.plugins.Filters(['telemetry.plot.overlay', 'table']));
    openmct.install(openmct.plugins.DisplayLayout({ showAsView: ['summary-widget'] }));
    openmct.install(openmct.plugins.Conductor({
        menuOptions: [
            {
                name: 'Realtime',
                timeSystem: 'utc',
                clock: window.StarPi.clock.key,
                clockOffsets: {
                    start: -FIFTEEN_MINUTES,
                    end: LEAD
                }
            },
            {
                name: 'Fixed',
                timeSystem: 'utc',
                bounds: {
                    start: Date.now() - FIFTEEN_MINUTES,
                    end: Date.now()
                }
            }
        ]
    }));
    // A jump of the rocket clock (first heard, restarted) would reach the
    // views as an ordinary tick, which they take for a small step: they would
    // keep the window they loaded before it. Re-applying the offsets makes
    // them load the new one.
    window.StarPi.clock.onJump(function () {
        if (openmct.time.isRealTime() && openmct.time.getClock() === window.StarPi.clock) {
            openmct.time.setClockOffsets(openmct.time.getClockOffsets());
        }
    });
    // UTCTimeSystem still registers the local clock, and a URL saved before
    // the rocket clock (tc.mode=local) would select it: never run on it.
    // Switched once every listener has seen the change, or the conductor bar
    // would take that event last and keep showing the local clock.
    openmct.time.on('clockChanged', function (clock) {
        if (clock && clock.key === 'local') {
            setTimeout(function () {
                openmct.time.setClock(window.StarPi.clock);
                openmct.time.setClockOffsets(openmct.time.getClockOffsets());
            });
        }
    });
    openmct.install(openmct.plugins.SummaryWidget());
    openmct.install(openmct.plugins.Notebook());
    openmct.install(openmct.plugins.LADTable());
    openmct.install(openmct.plugins.ClearData(['table', 'telemetry.plot.overlay', 'telemetry.plot.stacked']));
    openmct.install(openmct.plugins.ScatterPlot());

    openmct.install(window.StarPiPlugin());
    openmct.install(window.StarPiCommands());
    openmct.install(window.StarPiLaunchControl());
    openmct.install(window.StarPiRocketView());

    // A link to a specific object wins; otherwise open Launch Control, the
    // main dashboard.
    const linked = Boolean(window.location.hash);
    const HOME = '#/browse/starpi:root/starpi:launch-control';

    openmct.on('start', async function () {
        try {
            await window.StarPiDashboard.seed(openmct);
        } catch (error) {
            console.error('StarPi: could not create the flight dashboard', error);
        }
        window.StarPi.flight.watchSettings();
        if (!linked) {
            window.location.hash = HOME;
        }
    });

    document.addEventListener('DOMContentLoaded', function () {
        openmct.start();
    });
}());
