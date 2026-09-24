/*
 * Canvas drawing for the Launch Control view: time-series strips and the GPS
 * range plot. No dependencies; colors come from the view's CSS custom
 * properties so the canvas follows the stylesheet.
 */
(function () {
    function cssVar(element, name) {
        return getComputedStyle(element).getPropertyValue(name).trim();
    }

    /** Size a canvas to its CSS box at device resolution; returns the 2D context. */
    function prepare(canvas) {
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);

        return { ctx, width, height };
    }

    /** Round step (1, 2, 5 × 10^n) giving about `count` ticks over `span`. */
    function niceStep(span, count) {
        const raw = span / Math.max(1, count);
        const power = 10 ** Math.floor(Math.log10(raw));
        const unit = raw / power;
        const nice = unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10;

        return nice * power;
    }

    function formatTick(value, step) {
        const decimals = Math.max(0, -Math.floor(Math.log10(step)));

        return value.toFixed(Math.min(decimals, 3));
    }

    /**
     * A single-series strip chart over [start, end].
     *
     * @param {object} spec
     *   series: [{ t, v }] sorted by t
     *   start, end: time window (ms)
     *   events: [{ t, phase }] drawn as labelled vertical rules
     *   zero: draw the y = 0 line (speed)
     *   floor: minimum y range, so a flat pad trace does not fill the height with noise
     */
    function drawStrip(canvas, spec) {
        const { ctx, width, height } = prepare(canvas);
        const root = canvas.closest('.starpi-lc') || document.body;
        const ink = cssVar(root, '--lc-ink-3');
        const grid = cssVar(root, '--lc-grid');
        const line = cssVar(root, '--lc-data');
        const eventInk = cssVar(root, '--lc-ink-2');
        const font = cssVar(root, '--lc-font');

        const left = 44;
        const right = 8;
        const top = 8;
        const bottom = 20;
        const plotW = Math.max(1, width - left - right);
        const plotH = Math.max(1, height - top - bottom);
        const span = Math.max(1, spec.end - spec.start);

        const visible = spec.series.filter((p) => p.t >= spec.start && p.t <= spec.end);
        let min = Infinity;
        let max = -Infinity;
        for (const p of visible) {
            if (p.v < min) min = p.v;
            if (p.v > max) max = p.v;
        }
        if (!Number.isFinite(min)) {
            min = 0;
            max = 1;
        }
        if (spec.zero) {
            min = Math.min(min, 0);
            max = Math.max(max, 0);
        }
        const floor = spec.floor || 1;
        if (max - min < floor) {
            const mid = (max + min) / 2;
            min = mid - floor / 2;
            max = mid + floor / 2;
        }
        const pad = (max - min) * 0.08;
        min -= pad;
        max += pad;

        const x = (t) => left + ((t - spec.start) / span) * plotW;
        const y = (v) => top + (1 - (v - min) / (max - min)) * plotH;

        ctx.font = `11px ${font}`;
        ctx.lineWidth = 1;

        // Horizontal grid and value labels.
        const step = niceStep(max - min, Math.max(2, Math.floor(plotH / 32)));
        ctx.fillStyle = ink;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
            const py = Math.round(y(v)) + 0.5;
            ctx.strokeStyle = grid;
            ctx.beginPath();
            ctx.moveTo(left, py);
            ctx.lineTo(left + plotW, py);
            ctx.stroke();
            ctx.fillText(formatTick(v, step), left - 6, py);
        }

        if (spec.zero && min < 0 && max > 0) {
            const py = Math.round(y(0)) + 0.5;
            ctx.strokeStyle = ink;
            ctx.beginPath();
            ctx.moveTo(left, py);
            ctx.lineTo(left + plotW, py);
            ctx.stroke();
        }

        // Time labels: clock time, every nice number of seconds.
        const tStep = niceStep(span / 1000, Math.max(2, Math.floor(plotW / 90))) * 1000;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let t = Math.ceil(spec.start / tStep) * tStep; t <= spec.end; t += tStep) {
            const label = new Date(t).toISOString().slice(11, tStep < 60000 ? 19 : 16);
            ctx.fillText(label, x(t), top + plotH + 5);
        }

        // Phase events. Events close together (a short flight in a long
        // window) stack their labels in rows, and drop the ones that won't fit.
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const rowEnds = [];
        const rows = Math.max(1, Math.min(3, Math.floor(plotH / 40)));
        for (const event of spec.events || []) {
            if (event.t < spec.start || event.t > spec.end) continue;
            const px = Math.round(x(event.t)) + 0.5;
            ctx.strokeStyle = eventInk;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px, top);
            ctx.lineTo(px, top + plotH);
            ctx.stroke();
            ctx.setLineDash([]);

            const label = event.label || event.phase;
            const labelW = ctx.measureText(label).width;
            let lx = px + 3;
            if (lx + labelW > left + plotW) {
                lx = px - 3 - labelW;
            }
            for (let row = 0; row < rows; row++) {
                if (lx > (rowEnds[row] ?? -Infinity) + 4) {
                    rowEnds[row] = lx + labelW;
                    ctx.fillStyle = cssVar(root, '--lc-panel');
                    ctx.fillRect(lx - 2, top + 1 + row * 13, labelW + 4, 12);
                    ctx.fillStyle = eventInk;
                    ctx.fillText(label, lx, top + 1 + row * 13);
                    break;
                }
            }
        }

        // The series, with gaps where telemetry stopped for more than 2 s.
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.75;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let previous = null;
        for (const p of visible) {
            if (previous === null || p.t - previous > 2000) {
                ctx.moveTo(x(p.t), y(p.v));
            } else {
                ctx.lineTo(x(p.t), y(p.v));
            }
            previous = p.t;
        }
        ctx.stroke();

        // Latest point.
        const last = visible[visible.length - 1];
        if (last) {
            ctx.fillStyle = line;
            ctx.beginPath();
            ctx.arc(x(last.t), y(last.v), 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /**
     * Pad-centred plan view: range rings, north up, the ground track and the
     * rocket's current position.
     *
     * @param {object} spec  pad {lat, lon} | null, track [{lat, lon}], fix {lat, lon} | null
     * @param {function} offset  (from, to) -> {east, north} metres
     */
    function drawRange(canvas, spec, offset) {
        const { ctx, width, height } = prepare(canvas);
        const root = canvas.closest('.starpi-lc') || document.body;
        const ink = cssVar(root, '--lc-ink-3');
        const grid = cssVar(root, '--lc-grid');
        const line = cssVar(root, '--lc-data');
        const strong = cssVar(root, '--lc-ink');
        const font = cssVar(root, '--lc-font');

        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.max(10, Math.min(width, height) / 2 - 14);

        ctx.font = `11px ${font}`;
        if (!spec.pad) {
            ctx.fillStyle = ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for a GPS fix', cx, cy);

            return;
        }

        const points = spec.track.map((p) => offset(spec.pad, p));
        if (spec.fix) {
            points.push(offset(spec.pad, spec.fix));
        }
        const farthest = points.reduce((m, p) => Math.max(m, Math.hypot(p.east, p.north)), 0);
        // About three rings, the outer one just beyond the farthest point (at least 50 m).
        const reach = Math.max(50, farthest * 1.15);
        const ring = niceStep(reach, 3);
        const outer = Math.ceil(reach / ring) * ring;
        const scale = radius / outer;

        ctx.lineWidth = 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        for (let r = ring; r <= outer + 1e-6; r += ring) {
            ctx.strokeStyle = grid;
            ctx.beginPath();
            ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = ink;
            ctx.fillText(r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${r} m`, cx + r * scale * 0.71 + 3, cy - r * scale * 0.71);
        }

        // Crosshair and north marker.
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(cx - radius, cy);
        ctx.lineTo(cx + radius, cy);
        ctx.moveTo(cx, cy - radius);
        ctx.lineTo(cx, cy + radius);
        ctx.stroke();
        ctx.fillStyle = strong;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('N', cx, cy - radius - 1);

        // Pad.
        ctx.strokeStyle = strong;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx - 4, cy - 4, 8, 8);

        const px = (p) => cx + p.east * scale;
        const py = (p) => cy - p.north * scale;

        if (points.length > 1) {
            ctx.strokeStyle = line;
            ctx.lineWidth = 1.75;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            points.forEach((p, i) => (i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p))));
            ctx.stroke();
        }

        if (spec.fix) {
            const here = points[points.length - 1];
            ctx.fillStyle = line;
            ctx.beginPath();
            ctx.arc(px(here), py(here), 4.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    window.StarPiCharts = { drawStrip, drawRange, niceStep };
}());
