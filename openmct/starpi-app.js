const openmct = window.openmct;

(function () {
    const FIFTEEN_MINUTES = 15 * 60 * 1000;

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
                    end: 0
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

    openmct.install(window.StarPiPlugin());

    document.addEventListener('DOMContentLoaded', function () {
        openmct.start();
    });
}());
