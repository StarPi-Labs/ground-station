# Open MCT comes from npm (pinned by openmct/package-lock.json); the site files
# come from the `openmct` build context declared in docker-compose.yml.
FROM node:24-alpine AS openmct
WORKDIR /build
COPY --from=site package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM httpd:2.4-alpine
RUN rm /usr/local/apache2/htdocs/index.html
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
RUN mkdir -p /usr/local/apache2/conf/sites/
COPY openmct.conf /usr/local/apache2/conf/sites/openmct.conf
COPY .htpasswd /usr/local/apache2/conf/.htpasswd

COPY --from=openmct /build/node_modules/openmct/dist /usr/local/apache2/htdocs/openmct/node_modules/openmct/dist
COPY --from=openmct /build/node_modules/three/build /usr/local/apache2/htdocs/openmct/node_modules/three/build
COPY --from=openmct /build/node_modules/maplibre-gl/dist /usr/local/apache2/htdocs/openmct/node_modules/maplibre-gl/dist
COPY --from=openmct /build/node_modules/pmtiles/dist /usr/local/apache2/htdocs/openmct/node_modules/pmtiles/dist
COPY --from=openmct /build/node_modules/@protomaps/basemaps/dist /usr/local/apache2/htdocs/openmct/node_modules/@protomaps/basemaps/dist
COPY --from=openmct /build/node_modules/@fontsource-variable/inter/index.css /usr/local/apache2/htdocs/openmct/node_modules/@fontsource-variable/inter/
COPY --from=openmct /build/node_modules/@fontsource-variable/inter/files/*-wght-normal.woff2 /usr/local/apache2/htdocs/openmct/node_modules/@fontsource-variable/inter/files/
COPY --from=openmct /build/node_modules/@fontsource-variable/inter/LICENSE /usr/local/apache2/htdocs/openmct/licenses/inter.txt
COPY --from=openmct /build/node_modules/maplibre-gl/LICENSE.txt /usr/local/apache2/htdocs/openmct/licenses/maplibre-gl.txt
COPY --from=site index.html theme.js starpi-app.js starpi-plugin.js /usr/local/apache2/htdocs/openmct/
COPY --from=site flight/flight-state.js flight/flight-service.js /usr/local/apache2/htdocs/openmct/flight/
COPY --from=site commands/commands-panel.js commands/commands-panel.css /usr/local/apache2/htdocs/openmct/commands/
COPY --from=site brand/brand.js brand/brand.css brand/openmct-accent.css brand/openmct-overrides.css /usr/local/apache2/htdocs/openmct/brand/
COPY --from=site brand/assets/ /usr/local/apache2/htdocs/openmct/brand/assets/
COPY --from=site dashboard/seed.js /usr/local/apache2/htdocs/openmct/dashboard/
COPY --from=site launch-control/charts.js launch-control/basemap.js launch-control/launch-control.js launch-control/launch-control.css /usr/local/apache2/htdocs/openmct/launch-control/
COPY --from=site rocket/rocket-view.js rocket/rocket-view.css /usr/local/apache2/htdocs/openmct/rocket/
COPY --from=site licenses/ /usr/local/apache2/htdocs/openmct/licenses/
# Offline launch site map from `make tiles`; only a README when there is none.
COPY --from=site tiles/ /usr/local/apache2/htdocs/openmct/tiles/
