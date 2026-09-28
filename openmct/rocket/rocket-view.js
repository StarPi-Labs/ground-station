/*
 * "Rocket attitude": a 3D model of the rocket turned to the orientation it
 * reports (T_ORIENTATION), with cues for the estimated flight state: an
 * exhaust flame during the burn, the drogue from apogee, the main parachute
 * once the descent slows (flight.phase and flight.recovery, flight-service.js).
 *
 * Follows the time conductor like any other view: Real-time shows the live
 * rocket, Fixed shows it at the end of the selected window.
 *
 * three.js comes from npm (openmct/package.json) and is loaded on first use,
 * so pages that never open this view do not pay for it.
 */
(function () {
    const NAMESPACE = 'starpi';
    const TYPE = 'starpi.rocket';
    const THREE_URL = '/node_modules/three/build/three.module.js';
    const STALE_CHECK_MS = 500;
    // Frames are drawn only while something moves (a Pi has little GPU to
    // spare): easing stops once within this of its target (rad, model units).
    const SETTLED = 1e-3;
    // Attitude changes smaller than this (rad, 1°) are sensor noise at this
    // scale: they would keep the view redrawing on a rocket sitting still.
    // The readouts still show the exact angles.
    const ATTITUDE_DEADBAND = Math.PI / 180;

    // How the IMU's orientation maps onto the model: the rocket's long axis is
    // the IMU's Z (the accelerometer reads thrust on Z), X and Y are the tilts,
    // Z the roll. Angles in degrees, applied as intrinsic X, then Y, then Z.
    const EULER_ORDER = 'XYZ';

    const PHASE_LABELS = {
        PAD: 'On pad',
        BOOST: 'Boost',
        COAST: 'Coast',
        APOGEE: 'Apogee',
        DESCENT: 'Descent',
        LANDED: 'Landed'
    };
    const RECOVERY_LABELS = { NONE: 'Stowed', DROGUE: 'Drogue out', MAIN: 'Main out' };

    const COLORS = {
        body: 0xeef0f3,
        accent: 0xd8412f,
        roll: 0x2f7fd8, // one fin, so the roll shows
        dark: 0x2a2d33,
        flameOuter: 0xff7a1a,
        flameInner: 0xfff1b8,
        drogue: [0xff8c1a, 0x1c1f24],
        main: [0xe8412f, 0xf2f2f2],
        line: 0xb8bec8,
        grid: 0x59606b,
        gridCentre: 0x7d8591
    };

    // Model units: the rocket is 2 long, centred on its middle.
    const TAIL_Y = -1;
    const NOSE_Y = 1;
    const BODY_TOP_Y = 0.55;
    const RADIUS = 0.075;
    const ATTACH_Y = 0.25; // where the shock cord leaves the body
    const CHUTES = {
        DROGUE: { radius: 0.4, height: 2, colors: COLORS.drogue, lines: 1.1 },
        MAIN: { radius: 1.05, height: 2.9, colors: COLORS.main, lines: 1.5 }
    };

    let threePromise = null;

    function loadThree() {
        threePromise ??= import(THREE_URL).catch((error) => {
            threePromise = null;
            throw error;
        });

        return threePromise;
    }

    function fixed(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits) : '—';
    }

    const TEMPLATE = `
        <div class="starpi-rocket">
            <div class="sr-canvas" data-ref="stage" title="Drag to orbit, double-click to reset"></div>
            <div class="sr-overlay">
                <div class="sr-chips">
                    <span class="sr-chip" data-ref="phase">—</span>
                    <span class="sr-chip" data-ref="recovery" hidden></span>
                    <span class="sr-chip sr-chip--warn" data-ref="stale" hidden>No orientation data</span>
                </div>
                <dl class="sr-angles">
                    <div><dt>X</dt><dd data-ref="x">—</dd></div>
                    <div><dt>Y</dt><dd data-ref="y">—</dd></div>
                    <div><dt>Z</dt><dd data-ref="z">—</dd></div>
                </dl>
            </div>
            <p class="sr-hint">Axes as reported by the flight computer · drag to orbit, double-click to reset</p>
            <p class="sr-message" data-ref="message" hidden></p>
        </div>`;

    // --- the 3D scene -------------------------------------------------------------

    class RocketScene {
        constructor(THREE, container) {
            this.THREE = THREE;
            this.container = container;
            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            container.appendChild(this.renderer.domElement);

            this.scene = new THREE.Scene();
            this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
            this.orbit = { azimuth: 0.6, elevation: 0.18 };
            this.view = { centre: 0, size: 2.6 }; // what the camera frames, eased

            this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343a, 1.6));
            const sun = new THREE.DirectionalLight(0xffffff, 2.2);
            sun.position.set(3, 5, 4);
            this.scene.add(sun);

            const grid = new THREE.PolarGridHelper(2.4, 8, 5, 64, COLORS.gridCentre, COLORS.grid);
            grid.position.y = -1.35;
            grid.material.transparent = true;
            grid.material.opacity = 0.45;
            this.scene.add(grid);

            // scene > imuFrame (IMU Z up) > attitude (telemetry) > model (drawn along Y)
            this.imuFrame = new THREE.Group();
            this.imuFrame.rotation.x = -Math.PI / 2;
            this.attitude = new THREE.Group();
            this.model = this.buildRocket();
            this.model.rotation.x = Math.PI / 2;
            this.attitude.add(this.model);
            this.imuFrame.add(this.attitude);
            this.scene.add(this.imuFrame);
            this.target = new THREE.Quaternion();

            this.flame = this.buildFlame();
            this.model.add(this.flame);

            this.chutes = {
                DROGUE: this.buildChute(CHUTES.DROGUE),
                MAIN: this.buildChute(CHUTES.MAIN)
            };
            Object.values(this.chutes).forEach((chute) => this.scene.add(chute.group));

            this.state = { phase: null, recovery: 'NONE', hasAttitude: false };
            this.timer = new THREE.Timer();
            this.timer.connect(document);
        }

        buildRocket() {
            const THREE = this.THREE;
            const rocket = new THREE.Group();
            const material = (color, extra = {}) => new THREE.MeshStandardMaterial({
                color, roughness: 0.45, metalness: 0.1, ...extra
            });

            const body = new THREE.Mesh(
                new THREE.CylinderGeometry(RADIUS, RADIUS, BODY_TOP_Y - TAIL_Y, 32),
                material(COLORS.body)
            );
            body.position.y = (BODY_TOP_Y + TAIL_Y) / 2;
            rocket.add(body);

            // Nose cone.
            const points = [];
            const length = NOSE_Y - BODY_TOP_Y;
            for (let i = 0; i <= 16; i++) {
                const f = i / 16;
                points.push(new THREE.Vector2(RADIUS * Math.sqrt(1 - f * f) * (1 - 0.15 * f), BODY_TOP_Y + f * length));
            }
            rocket.add(new THREE.Mesh(new THREE.LatheGeometry(points, 32), material(COLORS.accent)));

            // Bands: the separation joint and the motor section.
            for (const [y, h] of [[ATTACH_Y, 0.04], [TAIL_Y + 0.02, 0.04]]) {
                const band = new THREE.Mesh(
                    new THREE.CylinderGeometry(RADIUS * 1.02, RADIUS * 1.02, h, 32),
                    material(COLORS.dark)
                );
                band.position.y = y;
                rocket.add(band);
            }

            // Four clipped-delta fins; the first (towards the IMU's +X) in another colour.
            const shape = new THREE.Shape();
            shape.moveTo(0, 0);
            shape.lineTo(0, 0.38);
            shape.lineTo(0.2, 0.18);
            shape.lineTo(0.2, -0.02);
            shape.lineTo(0, 0);
            const fin = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
            fin.translate(RADIUS * 0.9, TAIL_Y, -0.006);
            for (let i = 0; i < 4; i++) {
                const mesh = new THREE.Mesh(fin, material(i === 0 ? COLORS.roll : COLORS.accent));
                mesh.rotation.y = -i * Math.PI / 2;
                rocket.add(mesh);
            }

            const nozzle = new THREE.Mesh(
                new THREE.CylinderGeometry(RADIUS * 0.55, RADIUS * 0.75, 0.06, 24, 1, true),
                material(COLORS.dark, { side: THREE.DoubleSide })
            );
            nozzle.position.y = TAIL_Y - 0.03;
            rocket.add(nozzle);

            return rocket;
        }

        buildFlame() {
            const THREE = this.THREE;
            const flame = new THREE.Group();
            const cone = (radius, length, color, opacity) => {
                // Base on the nozzle, apex pointing away from it.
                const geometry = new THREE.ConeGeometry(radius, length, 24, 1, true);
                geometry.rotateX(Math.PI);
                geometry.translate(0, -length / 2, 0);

                return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                    side: THREE.DoubleSide
                }));
            };
            flame.add(cone(RADIUS * 1.1, 1.1, COLORS.flameOuter, 0.8));
            flame.add(cone(RADIUS * 0.6, 0.6, COLORS.flameInner, 0.95));
            flame.position.y = TAIL_Y - 0.06;
            const light = new THREE.PointLight(COLORS.flameOuter, 3, 3);
            light.position.y = -0.2;
            flame.add(light);
            flame.visible = false;

            return flame;
        }

        /** Canopy of alternating gores, shroud lines to a confluence point, shock cord to the rocket. */
        buildChute({ radius, colors, lines }) {
            const THREE = this.THREE;
            const group = new THREE.Group();
            const canopy = new THREE.Group();
            const gores = 12;
            for (let i = 0; i < gores; i++) {
                const geometry = new THREE.SphereGeometry(
                    radius, 4, 10, (i / gores) * Math.PI * 2, (Math.PI * 2) / gores, 0, Math.PI * 0.42
                );
                canopy.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
                    color: colors[i % 2], roughness: 0.8, side: THREE.DoubleSide
                })));
            }
            group.add(canopy);

            const rimY = radius * Math.cos(Math.PI * 0.42);
            const rimR = radius * Math.sin(Math.PI * 0.42);
            const confluence = -radius * lines;
            const positions = [];
            for (let i = 0; i < gores; i++) {
                const a = (i / gores) * Math.PI * 2;
                positions.push(rimR * Math.cos(a), rimY, rimR * Math.sin(a), 0, confluence, 0);
            }
            const shroud = new THREE.BufferGeometry();
            shroud.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const lineMaterial = new THREE.LineBasicMaterial({ color: COLORS.line, transparent: true, opacity: 0.8 });
            group.add(new THREE.LineSegments(shroud, lineMaterial));

            // Shock cord, in world space: its ends move every frame.
            const cordGeometry = new THREE.BufferGeometry();
            cordGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(6).fill(0), 3));
            const cord = new THREE.Line(cordGeometry, lineMaterial);
            cord.frustumCulled = false;
            this.scene.add(cord);

            group.visible = false;
            cord.visible = false;

            return { group, canopy, cord, confluence, inflation: 0 };
        }

        /** Returns true when the model has to turn. */
        setAttitude(x, y, z) {
            if (![x, y, z].every(Number.isFinite)) {
                return false;
            }
            const rad = Math.PI / 180;
            const next = new this.THREE.Quaternion().setFromEuler(
                new this.THREE.Euler(x * rad, y * rad, z * rad, EULER_ORDER)
            );
            if (this.state.hasAttitude && next.angleTo(this.target) < ATTITUDE_DEADBAND) {
                return false;
            }
            this.target.copy(next);
            if (!this.state.hasAttitude) {
                this.attitude.quaternion.copy(this.target);
                this.state.hasAttitude = true;
            }

            return true;
        }

        /** Returns true when the flame or parachutes change. */
        setFlight(phase, recovery) {
            const changed = phase !== this.state.phase || recovery !== this.state.recovery;
            this.state.phase = phase;
            this.state.recovery = recovery;

            return changed;
        }

        /** The container's size, as its ResizeObserver reports it. */
        setSize(width, height) {
            this.size = { width: Math.round(width), height: Math.round(height) };
        }

        resize() {
            // Not read from the container: measuring it every frame forced the
            // browser to lay out the whole, constantly changing, dashboard first.
            const { width, height } = this.size ?? {};
            if (!width || !height) {
                return false;
            }
            if (width !== this.width || height !== this.height) {
                this.width = width;
                this.height = height;
                this.renderer.setSize(width, height, false);
                this.camera.aspect = width / height;
                this.camera.updateProjectionMatrix();
            }

            return true;
        }

        /** Draw one frame; returns true while something is still moving and needs the next one. */
        frame() {
            if (!this.resize()) {
                return false;
            }
            this.timer.update();
            // Coming back from idle, the time since the last frame is no step to ease by.
            const dt = this.animating ? Math.min(this.timer.getDelta(), 0.1) : 1 / 60;
            const t = this.timer.getElapsed();
            const ease = (rate) => 1 - Math.exp(-dt * rate);
            const { phase, recovery } = this.state;

            this.attitude.quaternion.slerp(this.target, ease(12));
            const turning = this.attitude.quaternion.angleTo(this.target) > SETTLED;
            if (!turning) {
                this.attitude.quaternion.copy(this.target);
            }

            // Flame: only while the motor burns, flickering.
            this.flame.visible = phase === 'BOOST';
            if (this.flame.visible) {
                const flicker = 1 + 0.18 * Math.sin(t * 47) + 0.12 * Math.sin(t * 83 + 1.3);
                this.flame.scale.set(1 + 0.08 * Math.sin(t * 61), flicker, 1 + 0.08 * Math.sin(t * 61));
            }

            // Parachutes hang above the rocket in world space, whatever its attitude.
            const airborne = phase === 'APOGEE' || phase === 'DESCENT';
            let top = NOSE_Y;
            for (const [key, chute] of Object.entries(this.chutes)) {
                const out = airborne && recovery === key;
                if (!out) {
                    chute.inflation = 0;
                    chute.group.visible = false;
                    chute.cord.visible = false;
                    continue;
                }
                const spec = CHUTES[key];
                chute.inflation += (1 - chute.inflation) * ease(4);
                const breathe = 1 + 0.03 * Math.sin(t * 2.3);
                chute.canopy.scale.set(chute.inflation * breathe, chute.inflation, chute.inflation * breathe);
                chute.group.position.set(0.12 * Math.sin(t * 0.9), spec.height, 0.08 * Math.cos(t * 0.7));
                chute.group.rotation.set(0.05 * Math.sin(t * 0.8), 0, 0.06 * Math.sin(t * 1.1));
                chute.group.visible = true;

                const from = chute.group.localToWorld(new this.THREE.Vector3(0, chute.confluence, 0));
                this.model.updateWorldMatrix(true, false);
                const to = this.model.localToWorld(new this.THREE.Vector3(0, ATTACH_Y, 0));
                const cord = chute.cord.geometry.attributes.position;
                cord.setXYZ(0, from.x, from.y, from.z);
                cord.setXYZ(1, to.x, to.y, to.z);
                cord.needsUpdate = true;
                chute.cord.visible = true;
                top = Math.max(top, spec.height + spec.radius + 0.15); // canopy crown, plus sway
            }

            // Frame the rocket, and the canopy when there is one.
            const bottom = this.flame.visible ? -2.1 : -1.4;
            // The rocket tilts, so leave it some width; the main canopy needs more.
            const width = recovery === 'MAIN' && airborne ? CHUTES.MAIN.radius * 2.4 : 1.5;
            const centre = (top + bottom) / 2;
            const height = top - bottom;
            const fov = (this.camera.fov * Math.PI) / 180;
            const size = Math.max(height, width / this.camera.aspect);
            this.view.centre += (centre - this.view.centre) * ease(3);
            this.view.size += (size - this.view.size) * ease(3);
            const reframing = Math.abs(centre - this.view.centre) > SETTLED || Math.abs(size - this.view.size) > SETTLED;
            if (!reframing) {
                this.view.centre = centre;
                this.view.size = size;
            }
            const distance = (this.view.size * 0.62) / Math.tan(fov / 2);
            const { azimuth, elevation } = this.orbit;
            this.camera.position.set(
                distance * Math.cos(elevation) * Math.sin(azimuth),
                this.view.centre + distance * Math.sin(elevation),
                distance * Math.cos(elevation) * Math.cos(azimuth)
            );
            this.camera.lookAt(0, this.view.centre, 0);

            this.renderer.render(this.scene, this.camera);

            // The flame flickers and the canopies sway for as long as they show.
            this.animating = turning || reframing || this.flame.visible || (airborne && recovery !== 'NONE');

            return this.animating;
        }

        dispose() {
            this.timer.dispose();
            this.scene.traverse((node) => {
                node.geometry?.dispose();
                [].concat(node.material ?? []).forEach((material) => material.dispose());
            });
            this.renderer.dispose();
            this.renderer.domElement.remove();
        }
    }

    // --- view -----------------------------------------------------------------------

    class RocketView {
        constructor(openmct) {
            this.openmct = openmct;
            this.generation = 0;
            this.unsubscribers = [];
            this.latest = { orientation: null, phase: null, recovery: null };
            this.onBounds = this.onBounds.bind(this);
            this.load = this.load.bind(this);
        }

        show(element) {
            element.innerHTML = TEMPLATE;
            this.refs = {};
            element.querySelectorAll('[data-ref]').forEach((node) => {
                this.refs[node.dataset.ref] = node;
            });

            this.openmct.time.on('boundsChanged', this.onBounds);
            this.openmct.time.on('modeChanged', this.load);
            this.openmct.time.on('clockChanged', this.load);

            loadThree().then((THREE) => {
                if (this.destroyed) {
                    return;
                }
                try {
                    this.scene = new RocketScene(THREE, this.refs.stage);
                } catch (error) {
                    this.message('3D view unavailable: this browser could not start WebGL.');
                    console.error('StarPi: could not start the rocket view', error);

                    return;
                }
                this.bindOrbit(this.refs.stage);
                // Layouts size the view after it is shown, and resize it later.
                this.resize = new ResizeObserver((entries) => {
                    const { width, height } = entries[entries.length - 1].contentRect;
                    this.scene.setSize(width, height);
                    this.requestFrame();
                });
                this.resize.observe(this.refs.stage);
                this.apply();
            }, (error) => {
                this.message('3D view unavailable: could not load three.js.');
                console.error('StarPi: could not load three.js', error);
            });

            this.subscribe().then(this.load);
            this.staleTimer = setInterval(() => this.renderStale(), STALE_CHECK_MS);
        }

        destroy() {
            this.destroyed = true;
            this.generation += 1;
            cancelAnimationFrame(this.frame);
            cancelAnimationFrame(this.applyFrame);
            this.resize?.disconnect();
            clearInterval(this.staleTimer);
            this.unsubscribers.forEach((unsubscribe) => unsubscribe());
            this.openmct.time.off('boundsChanged', this.onBounds);
            this.openmct.time.off('modeChanged', this.load);
            this.openmct.time.off('clockChanged', this.load);
            this.scene?.dispose();
        }

        /** Draw on the next animation frame, and keep drawing while the scene animates. */
        requestFrame() {
            if (!this.scene || this.frame || this.destroyed) {
                return;
            }
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                if (this.scene.frame()) {
                    this.requestFrame();
                }
            });
        }

        message(text) {
            this.refs.message.textContent = text;
            this.refs.message.hidden = false;
        }

        // --- data ---------------------------------------------------------------------

        async subscribe() {
            const keys = { orientation: 'T_ORIENTATION', phase: 'flight.phase', recovery: 'flight.recovery' };
            const objects = {};
            await Promise.all(Object.entries(keys).map(async ([name, key]) => {
                objects[name] = await this.openmct.objects.get({ namespace: NAMESPACE, key });
            }));
            if (this.destroyed) {
                return;
            }
            for (const [name, object] of Object.entries(objects)) {
                this.unsubscribers.push(this.openmct.telemetry.subscribe(object, (datum) => {
                    if (this.openmct.time.isRealTime() && !this.loading) {
                        this.update(name, datum);
                    }
                }));
            }
            this.objects = objects;
        }

        onBounds(bounds, isTick) {
            if (!isTick) {
                this.load();
            }
        }

        /** The latest value of each source up to the end of the conductor's window. */
        async load() {
            if (!this.objects || this.destroyed) {
                return;
            }
            const generation = ++this.generation;
            const { end } = this.openmct.time.getBounds();
            this.loading = true;
            try {
                const results = await Promise.all(Object.entries(this.objects).map(async ([name, object]) => {
                    const data = await this.openmct.telemetry.request(object, {
                        strategy: 'latest', size: 1, end
                    });

                    return [name, data.at(-1) ?? null];
                }));
                if (generation !== this.generation) {
                    return;
                }
                this.latest = { orientation: null, phase: null, recovery: null };
                results.forEach(([name, datum]) => datum && this.update(name, datum));
            } catch (error) {
                console.warn('StarPi: could not load the rocket attitude', error);
            } finally {
                if (generation === this.generation) {
                    this.loading = false;
                    this.renderStale();
                }
            }
        }

        update(name, datum) {
            this.latest[name] = datum;
            // Orientation arrives faster than the screen refreshes: apply the
            // newest values once per frame instead of on every packet.
            this.applyFrame ??= requestAnimationFrame(() => {
                this.applyFrame = null;
                this.apply();
            });
        }

        /** Push the latest values into the scene and the overlay. */
        apply() {
            const { PHASES, RECOVERY } = window.StarPiFlight;
            const orientation = this.latest.orientation;
            const phase = this.latest.phase ? PHASES[this.latest.phase.value] : null;
            const recovery = (this.latest.recovery ? RECOVERY[this.latest.recovery.value] : null) ?? 'NONE';

            const turned = orientation ? this.scene?.setAttitude(orientation.x, orientation.y, orientation.z) : false;
            const staged = this.scene?.setFlight(phase, recovery);
            if (turned || staged) {
                this.requestFrame();
            }

            for (const axis of ['x', 'y', 'z']) {
                this.refs[axis].textContent = `${fixed(orientation?.[axis], 1)}°`;
            }
            this.refs.phase.textContent = phase ? PHASE_LABELS[phase] : 'No flight data';
            this.refs.phase.dataset.phase = phase ?? '';
            const showRecovery = recovery !== 'NONE' && phase !== 'PAD';
            this.refs.recovery.hidden = !showRecovery;
            this.refs.recovery.textContent = RECOVERY_LABELS[recovery];
            this.refs.recovery.dataset.recovery = recovery;
        }

        renderStale() {
            if (!this.refs) {
                return;
            }
            const stale = this.openmct.time.isRealTime()
                ? window.StarPi.stream.isStale('T_ORIENTATION')
                : !this.latest.orientation;
            this.refs.stale.hidden = !stale || this.loading;
        }

        // --- camera ---------------------------------------------------------------------

        bindOrbit(stage) {
            let drag = null;
            stage.addEventListener('pointerdown', (event) => {
                drag = { x: event.clientX, y: event.clientY, ...this.scene.orbit };
                stage.setPointerCapture(event.pointerId);
            });
            stage.addEventListener('pointermove', (event) => {
                if (!drag) {
                    return;
                }
                const orbit = this.scene.orbit;
                orbit.azimuth = drag.azimuth - (event.clientX - drag.x) * 0.01;
                orbit.elevation = Math.max(-0.2, Math.min(1.4, drag.elevation + (event.clientY - drag.y) * 0.01));
                this.requestFrame();
            });
            const release = () => {
                drag = null;
            };
            stage.addEventListener('pointerup', release);
            stage.addEventListener('pointercancel', release);
            stage.addEventListener('dblclick', () => {
                Object.assign(this.scene.orbit, { azimuth: 0.6, elevation: 0.18 });
                this.requestFrame();
            });
        }
    }

    window.StarPiRocketView = function StarPiRocketView() {
        return function install(openmct) {
            openmct.types.addType(TYPE, {
                name: 'Rocket Attitude',
                description: '3D model of the rocket at its reported orientation, with its flame and parachutes.',
                cssClass: 'icon-object'
            });

            openmct.objectViews.addProvider({
                key: 'starpi.rocket-view',
                name: 'Rocket Attitude',
                cssClass: 'icon-object',
                canView: (domainObject) => domainObject.type === TYPE,
                view() {
                    return new RocketView(openmct);
                },
                priority() {
                    return 1;
                }
            });
        };
    };
    // The view alone, for embedding in other views (Launch Control).
    window.StarPiRocketView.View = RocketView;
}());
