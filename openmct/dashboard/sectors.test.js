const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flight = require('../flight/flight-state.js');

function setup(key = 'logs-dashboard') {
    const context = { window: {
        StarPiFlight: flight,
        StarPi: { flight: { options: () => ({}) } }
    }, setInterval, clearInterval, ResizeObserver: class { observe() {} disconnect() {} } };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/sectors.js`, 'utf8'), context);
    const time = { getBounds: () => ({ start: 0, end: 10000 }), isRealTime: () => true, off() {} };
    const openmct = { time, telemetry: {} };
    const view = new context.window.StarPiSectors.View(openmct, key);
    // Open MCT assigns the provider key to every view after construction.
    view.key = 'starpi.sector-view';
    view.refs = { error: {}, loadState: {} };
    view.render = () => {};
    return { view, openmct, context };
}

test('map history accepts LIFO packet IDs and deduplicates live overlap', async () => {
    const { view, openmct } = setup('map-dashboard');
    view.objects = view.definition.channels.map((c) => ({ identifier: { key: c.key } }));
    openmct.telemetry.request = async (object) => {
        if (object.identifier.key === 'T_ROCKET_STATE') return [{ id: 50, utc: 10, state: 'IDLE' }];
        if (object.identifier.key === 'T_GPS') return [
            { id: 100, utc: 20, lat: 39, lon: -8 },
            { id: 99, utc: 30, lat: 39.001, lon: -8 },
            { id: 98, utc: 40, lat: 39.002, lon: -8 }
        ];
        return [];
    };
    await view.load();
    assert.equal(view.tracker.snapshot().fix.lat, 39.002);
    const gps = view.definition.channels.find((c) => c.key === 'T_GPS');
    view.ingest(gps, { id: 98, utc: 40, lat: 0, lon: 0 });
    assert.equal(view.tracker.snapshot().fix.lat, 39.002);
});

test('changing time bounds discards a superseded history response', async () => {
    const { view, openmct } = setup();
    view.objects = [{}];
    let finishOld;
    let calls = 0;
    openmct.telemetry.request = () => ++calls === 1 ? new Promise((resolve) => { finishOld = resolve; })
        : Promise.resolve([{ id: 2, utc: 2000, message: 'new window' }]);
    const oldLoad = view.load();
    await view.load();
    finishOld([{ id: 1, utc: 1000, message: 'old window' }]);
    await oldLoad;
    assert.equal(view.logEntries.length, 1);
    assert.equal(view.logEntries[0].message, 'new window');
});

test('a destroyed dashboard ignores pending history', async () => {
    const { view, openmct } = setup();
    view.objects = [{}];
    let finish;
    openmct.telemetry.request = () => new Promise((resolve) => { finish = resolve; });
    const pending = view.load();
    view.destroy();
    finish([{ id: 1, utc: 10, message: 'too late' }]);
    await pending;
    assert.equal(view.logEntries.length, 0);
});

test('failed history reports the affected source and keeps successful channels', async () => {
    const { view, openmct } = setup('commands-dashboard');
    view.objects = view.definition.channels.map((c) => ({ key: c.key }));
    openmct.telemetry.request = async (object) => {
        if (object.key === 'baro.speed') throw new Error('network failed');
        return [{ utc: 10, value: 42 }];
    };
    await view.load();
    assert.equal(view.latest['flight.agl'].value, 42);
    assert.match(view.refs.error.textContent, /Vertical speed/);
    assert.equal(view.loading, false);
});

test('live data received during a history fetch survives and duplicate IDs appear once', async () => {
    const { view, openmct } = setup();
    view.objects = [{}];
    let finish;
    openmct.telemetry.request = () => new Promise((resolve) => { finish = resolve; });
    const pending = view.load();
    const channel = view.definition.channels[0];
    view.queue.push([channel, { id: 1, utc: 10, message: 'history overlap' }]);
    view.queue.push([channel, { id: 2, utc: 20, message: 'live' }]);
    finish([{ id: 1, utc: 10, message: 'history overlap' }]);
    await pending;
    assert.deepEqual(Array.from(view.logEntries, (row) => row.message), ['history overlap', 'live']);
});

test('bounded flight plots keep the start and a narrow peak after compaction', () => {
    const { view } = setup('dynamics-dashboard');
    const channel = view.definition.channels[0];
    for (let i = 0; i <= 12000; i++) view.ingest(channel, { utc: i, value: i === 713 ? 999 : 0 });
    const series = view.rows[channel.key];
    assert.ok(series.length < 12000);
    assert.equal(series[0].t, 0);
    assert.ok(series.some((p) => p.t === 713 && p.v === 999));
    assert.equal(series.at(-1).t, 12000);
});

test('text logs retain the latest 2000 messages in rocket-time order', () => {
    const { view } = setup();
    const channel = view.definition.channels[0];
    for (let i = 0; i < 2100; i++) view.ingest(channel, { id: i, utc: i, message: `message ${i}` });
    assert.equal(view.logEntries.length, 2000);
    assert.equal(view.logEntries[0].utc, 100);
    assert.equal(view.logEntries.at(-1).utc, 2099);
});

test('paused log search uses frozen display entries while live messages keep buffering', () => {
    const { view } = setup();
    view.paused = true;
    view.displayEntries = [{ utc: 1, message: 'Calibration completed' }];
    view.refs.search = { value: 'CALIBRATION' };
    view.ingest(view.definition.channels[0], { id: 2, utc: 2, message: 'Launch' });
    assert.equal(view.filteredLogs().length, 1);
    assert.equal(view.filteredLogs()[0].message, 'Calibration completed');
    assert.equal(view.logEntries[0].message, 'Launch');
});

test('dashboard navigation destroys every subscription and embedded widget', () => {
    const { view } = setup();
    let disposed = 0;
    view.off = [() => disposed++, () => disposed++];
    for (const key of ['commands', 'rocket', 'basemap']) view[key] = { destroy: () => disposed++ };
    view.destroy();
    assert.equal(disposed, 5);
    assert.equal(view.destroyed, true);
});
