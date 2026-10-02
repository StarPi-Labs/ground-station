/*
 * StarPi brand for scripts: asset paths, the lockup, and the colour tokens of
 * brand.css read back as values, for canvases and saved objects that need a
 * colour rather than a CSS variable. brand.css stays the only place a colour
 * is written down.
 */
(function () {
    const ASSETS = '/brand/assets';

    const assets = {
        patch: `${ASSETS}/patch-512.png`,
        patchSmall: `${ASSETS}/patch-64.png`,
        wordmark: `${ASSETS}/wordmark.svg`,
        wordmarkGroundStation: `${ASSETS}/wordmark-ground-station.svg`
    };

    /** Value of a CSS custom property, as resolved on element (default <html>). */
    function cssVar(name, element = document.documentElement) {
        return getComputedStyle(element).getPropertyValue(name).trim();
    }

    /** Value of a brand token: color('night'), color('accent'), ... */
    function color(token, element) {
        return cssVar(`--sp-${token}`, element);
    }

    /** Markup of the patch + wordmark lockup (styled by brand.css). */
    function lockup({ subtitle = true } = {}) {
        return `
            <div class="sp-lockup" role="img" aria-label="StarPi Ground Station">
                <span class="sp-lockup__patch"></span>
                <span class="sp-lockup__text">
                    <span class="sp-wordmark"></span>
                    ${subtitle ? '<span class="sp-wordmark sp-wordmark--ground-station"></span>' : ''}
                </span>
            </div>`;
    }

    window.StarPiBrand = {
        name: 'StarPi Ground Station',
        assets,
        cssVar,
        color,
        lockup,
        /** Open MCT plugin: header logo and About dialog. */
        plugin() {
            return function install(openmct) {
                openmct.branding({
                    smallLogoImage: assets.patchSmall,
                    aboutHtml: `
                        <div class="sp-about">
                            ${lockup()}
                            <p>Ground station of the StarPi rocketry team, built on Open MCT
                            by NASA Ames Research Center.</p>
                        </div>`
                });
            };
        }
    };
}());
