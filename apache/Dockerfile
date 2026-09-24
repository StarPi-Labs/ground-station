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
COPY --from=site index.html starpi-app.js starpi-plugin.js /usr/local/apache2/htdocs/openmct/
