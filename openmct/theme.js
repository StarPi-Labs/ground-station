/*
 * Light / dark mode. Open MCT's own theme (Espresso or Snow) is a single
 * stylesheet it swaps in place, so the switch is live: no reload, no lost
 * history. Our views follow `data-theme` on <html> through their CSS custom
 * properties; canvases and maps that copy colours at draw time listen with
 * onChange() and redraw. The choice is per browser, like everything else.
 */
(function () {
    const KEY = 'starpi.theme';
    const THEMES = { dark: 'Espresso', light: 'Snow' };
    const listeners = new Set();

    function stored() {
        try {
            const value = window.localStorage.getItem(KEY);

            return value in THEMES ? value : null;
        } catch (error) {
            return null;
        }
    }

    // Dark unless chosen otherwise: the dashboard was designed for it.
    let current = stored() ?? 'dark';
    let openmct = null;

    function apply() {
        document.documentElement.dataset.theme = current;
        if (openmct) {
            openmct.install(openmct.plugins[THEMES[current]]());
        }
    }

    function set(name) {
        if (!(name in THEMES) || name === current) {
            return;
        }
        current = name;
        try {
            window.localStorage.setItem(KEY, name);
        } catch (error) {
            // Private window: the choice lasts until reload.
        }
        apply();
        listeners.forEach((listener) => listener(current));
    }

    function installIndicator() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'c-indicator icon-brightness';
        // An indicator that is a button: drop the browser's button look.
        button.style.cssText = 'border: 0; background: none; color: inherit; font: inherit; cursor: pointer;';
        const label = document.createElement('span');
        label.className = 'label c-indicator__label';
        button.append(label);
        const update = () => {
            const next = current === 'dark' ? 'light' : 'dark';
            label.textContent = `${next[0].toUpperCase()}${next.slice(1)} mode`;
            button.title = `Switch to ${next} mode`;
            button.setAttribute('aria-label', button.title);
        };
        button.addEventListener('click', () => set(current === 'dark' ? 'light' : 'dark'));
        listeners.add(update);
        update();
        openmct.indicators.add({ element: button, priority: openmct.priority.LOW });
    }

    window.StarPiTheme = {
        current: () => current,
        set,
        /** Calls listener(theme) on every change; returns the unsubscribe function. */
        onChange(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        /** Open MCT plugin: installs the chosen Open MCT theme and the header toggle. */
        plugin() {
            return function install(instance) {
                openmct = instance;
                apply();
                installIndicator();
            };
        }
    };

    // Before first paint, so our views never flash the wrong palette.
    document.documentElement.dataset.theme = current;
}());
