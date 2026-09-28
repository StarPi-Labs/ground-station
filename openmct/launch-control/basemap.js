/*
 * Offline map under the Launch Control range plot: OpenStreetMap vector tiles
 * (Protomaps) or satellite imagery, both from tiles/, which `make tiles`
 * writes (scripts/fetch-tiles.py) and the frontend image serves. Nothing is
 * fetched from the internet, and MapLibre (~1 MB) loads only once a map is
 * switched on. The map is never moved by hand: it follows the range plot's
 * centre (the pad) and scale, so the rings and track land on the ground.
 */
(function () {
    const SITE_URL = '/tiles/site.json';
    const MAPLIBRE_URL = '/node_modules/maplibre-gl/dist/maplibre-gl.mjs';
    const MAPLIBRE_CSS = '/node_modules/maplibre-gl/dist/maplibre-gl.css';
    const SCRIPTS = [
        '/node_modules/pmtiles/dist/pmtiles.js',
        '/node_modules/@protomaps/basemaps/dist/basemaps.js'
    ];
    // Web Mercator metres per pixel at zoom 0 on the equator, 512 px tiles.
    const ZOOM0_M_PER_PX = 40075016.686 / 512;
    const MODES = ['off', 'map', 'satellite'];

    let sitePromise = null;
    let libsPromise = null;

    /** The downloaded site (tiles/site.json), or null when there is none. */
    function site() {
        sitePromise ??= fetch(SITE_URL)
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null);

        return sitePromise;
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load ${src}`));
            document.head.append(script);
        });
    }

    function libs() {
        libsPromise ??= (async () => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = MAPLIBRE_CSS;
            document.head.append(css);
            const [maplibre] = await Promise.all([import(MAPLIBRE_URL), ...SCRIPTS.map(loadScript)]);
            maplibre.addProtocol('pmtiles', new window.pmtiles.Protocol().tile);

            return maplibre;
        })().catch((error) => {
            libsPromise = null;
            throw error;
        });

        return libsPromise;
    }

    function style(site) {
        // Absolute URLs for MapLibre's workers; built by hand, since URL()
        // would escape the {z}/{x}/{y} placeholders.
        const base = `${location.origin}/tiles/`;
        const { basemaps } = window;
        const mapLayers = basemaps.layers('protomaps', basemaps.namedFlavor('dark'), { lang: 'en' })
            .map((layer) => ({ ...layer, metadata: { starpi: 'map' } }));
        const style = {
            version: 8,
            glyphs: base + site.map.glyphs,
            sprite: base + site.map.sprite,
            sources: {
                protomaps: { type: 'vector', url: `pmtiles://${base}${site.map.url}`, attribution: site.map.attribution }
            },
            layers: [...mapLayers]
        };
        if (site.satellite) {
            style.sources.satellite = {
                type: 'raster',
                tiles: [base + site.satellite.tiles],
                tileSize: 256,
                minzoom: site.satellite.minzoom,
                maxzoom: site.satellite.maxzoom,
                bounds: site.satellite.bounds ?? site.bounds,
                attribution: site.satellite.attribution
            };
            style.layers.push({
                id: 'satellite',
                type: 'raster',
                source: 'satellite',
                metadata: { starpi: 'satellite' },
                layout: { visibility: 'none' }
            });
        }

        return style;
    }

    class Basemap {
        constructor(container) {
            this.container = container;
            this.mode = 'off';
            this.target = null;
        }

        /** 'off', 'map' or 'satellite'. Rejects if the map could not load. */
        async setMode(mode) {
            this.mode = MODES.includes(mode) ? mode : 'off';
            this.update();
            if (this.mode === 'off') {
                return;
            }
            this.creating ??= this.create().catch((error) => {
                this.creating = null;
                throw error;
            });
            await this.creating;
            this.applyMode();
        }

        async create() {
            const [maplibre, current] = await Promise.all([libs(), site()]);
            if (this.destroyed) {
                return;
            }
            if (!current) {
                throw new Error('No offline map: run `make tiles` and rebuild.');
            }
            this.map = new maplibre.Map({
                container: this.container,
                style: style(current),
                interactive: false,
                attributionControl: { compact: true },
                fadeDuration: 0,
                center: current.center,
                zoom: 14
            });
            this.update();
        }

        applyMode() {
            if (!this.map || this.destroyed) {
                return;
            }
            const apply = () => {
                for (const layer of this.map.getStyle().layers) {
                    const group = layer.metadata?.starpi;
                    if (group) {
                        this.map.setLayoutProperty(layer.id, 'visibility', group === this.mode ? 'visible' : 'none');
                    }
                }
            };
            if (this.map.isStyleLoaded()) {
                apply();
            } else {
                this.map.once('load', apply);
            }
            this.container.classList.toggle('is-satellite', this.mode === 'satellite');
        }

        /**
         * Centre the map on `center` ({lat, lon}) at `metresPerPixel`, or hide
         * it with center null (no pad yet).
         */
        view(center, metresPerPixel) {
            this.target = center && Number.isFinite(metresPerPixel) && metresPerPixel > 0
                ? { center, metresPerPixel }
                : null;
            this.update();
        }

        update() {
            this.container.hidden = this.mode === 'off' || this.target === null;
            if (!this.map || this.container.hidden) {
                return;
            }
            const { center, metresPerPixel } = this.target;
            const zoom = Math.log2(ZOOM0_M_PER_PX * Math.cos(center.lat * Math.PI / 180) / metresPerPixel);
            // Called on every GPS fix, but the pad and scale rarely change:
            // only redraw the map when they, or the container's size, do.
            const key = `${center.lat},${center.lon},${zoom},${this.container.clientWidth}x${this.container.clientHeight}`;
            if (key === this.applied) {
                return;
            }
            this.applied = key;
            this.map.resize();
            this.map.jumpTo({ center: [center.lon, center.lat], zoom });
        }

        destroy() {
            this.destroyed = true;
            this.map?.remove();
            this.map = null;
        }
    }

    window.StarPiBasemap = { site, Basemap };
}());
