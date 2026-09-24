const openmct = window.openmct;

(function () {
    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    // Real-time windows end a little in the future: views that drop data
    // newer than the window's end (gauges, LAD tables) would otherwise miss
    // fresh packets between two clock ticks, or all of them if the rocket's
    // clock runs slightly ahead of this machine's.
    const LEAD = 5 * 1000;

    openmct.setAssetPath('/node_modules/openmct/dist');

    // Layouts, notebooks and "My Items" live in the browser's local storage:
    // there is no CouchDB in this deployment.
    openmct.install(openmct.plugins.LocalStorage());
    openmct.install(openmct.plugins.Espresso());
    openmct.install(openmct.plugins.MyItems());
    openmct.install(openmct.plugins.UTCTimeSystem());
    openmct.install(openmct.plugins.TelemetryMean());
    openmct.install(openmct.plugins.Filters(['telemetry.plot.overlay', 'table']));
    openmct.install(openmct.plugins.DisplayLayout({ showAsView: ['summary-widget'] }));
    openmct.install(openmct.plugins.Conductor({
        menuOptions: [
            {
                name: 'Realtime',
                timeSystem: 'utc',
                clock: 'local',
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
    openmct.install(openmct.plugins.SummaryWidget());
    openmct.install(openmct.plugins.Notebook());
    openmct.install(openmct.plugins.LADTable());
    openmct.install(openmct.plugins.ClearData(['table', 'telemetry.plot.overlay', 'telemetry.plot.stacked']));
    openmct.install(openmct.plugins.ScatterPlot());

    openmct.install(window.StarPiPlugin());
    openmct.install(window.StarPiCommands());
    openmct.install(window.StarPiLaunchControl());

    // A link to a specific object wins; otherwise open the flight dashboard.
    const linked = Boolean(window.location.hash);

    openmct.on('start', async function () {
        try {
            await window.StarPiDashboard.seed(openmct);
        } catch (error) {
            console.error('StarPi: could not create the flight dashboard', error);
        }
        window.StarPi.flight.watchSettings();
        if (!linked) {
            window.location.hash = window.StarPiDashboard.PATH;
        }
    });

    document.addEventListener('DOMContentLoaded', function () {
        openmct.start();
    });
}());
