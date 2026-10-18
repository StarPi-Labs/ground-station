/*
 * Command panel: the commands the connected links accept, one row each with a
 * send button per link, each behind a confirm step, plus the recent command
 * history. The commands that fire a charge sit apart, locked until asked for. Open MCT has no commanding
 * UI of its own without YAMCS, so this is a small custom view: the "Commands"
 * object (addable to any Display Layout), also embedded in Launch Control.
 */
(function () {
    const POLL_MS = 5000;
    const CONFIRM_TIMEOUT_MS = 8000;
    // raw_write can write anything anywhere: API only, never a button.
    const HIDDEN_COMMANDS = new Set(['raw_write']);
    // These fire a charge on the rocket (COMMAND_IDS in the backend's
    // links/base.py; the API does not say which commands are hazardous).
    // Their send buttons work only for PYRO_UNLOCK_MS after "Unlock".
    const PYRO_COMMANDS = new Set(['eject_a', 'eject_c', 'cut_main']);
    const PYRO_UNLOCK_MS = 30000;
    // Shown when confirming these: what sending them does to the rocket.
    const CAUTIONS = {
        system_arm: 'Liftoff detection on: the rocket runs its flight states and recovery.',
        system_disarm: 'The rocket stays idle until armed again.',
        sensor_calibration: 'Rocket must be idle and still: IMU and barometers stop for about 10 s.'
    };

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function clock(ms) {
        return new Date(ms).toISOString().slice(11, 19);
    }

    class CommandsPanel {
        constructor(element) {
            this.element = element;
            this.available = [];
            this.history = [];
            this.pending = null;
            this.pyroUnlocked = false;
            this.inFlight = false;
            // Typed argument values, by command and parameter: kept across redraws.
            this.args = {};

            element.innerHTML = `
                <div class="sp-cmd">
                    <div class="sp-cmd__groups" data-ref="list"></div>
                    <p class="sp-cmd__result" data-ref="result" role="status"></p>
                    <h4 class="sp-cmd__heading">Recent</h4>
                    <ol class="sp-cmd__history" data-ref="history"></ol>
                </div>`;
            this.list = element.querySelector('[data-ref="list"]');
            this.result = element.querySelector('[data-ref="result"]');
            this.historyList = element.querySelector('[data-ref="history"]');
            this.list.addEventListener('click', (event) => this.onClick(event));
            this.list.addEventListener('input', (event) => {
                const { command, param } = event.target.dataset;
                if (command && param) {
                    this.args[command] = { ...this.args[command], [param]: event.target.value };
                }
            });

            this.offStation = window.StarPi.station.onStatus(() => this.render());
            this.poll();
            this.timer = setInterval(() => this.poll(), POLL_MS);
        }

        destroy() {
            this.destroyed = true;
            clearInterval(this.timer);
            clearTimeout(this.confirmTimer);
            clearTimeout(this.lockTimer);
            this.offStation();
        }

        linkUp(name) {
            const { station } = window.StarPi;

            return Boolean(station.ok && station.health?.links.some((l) => l.name === name && l.connected));
        }

        async poll() {
            if (this.inFlight) {
                return;
            }
            this.inFlight = true;
            try {
                const [available, history] = await Promise.all([
                    window.StarPi.api('/commands/available'),
                    window.StarPi.api('/commands?limit=5')
                ]);
                this.available = available.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name));
                this.history = history.commands;
            } catch (error) {
                // The station status already reports an unreachable backend.
            } finally {
                this.inFlight = false;
            }
            this.render();
        }

        onClick(event) {
            const button = event.target.closest('button[data-action]');
            if (!button) {
                return;
            }
            const { action, command, link } = button.dataset;

            if (action === 'arm') {
                const missing = this.argsFor(command).error;
                if (missing) {
                    this.result.className = 'sp-cmd__result is-alarm';
                    this.result.textContent = `${command}: ${missing}`;
                    return;
                }
                this.pending = `${command}@${link}`;
                clearTimeout(this.confirmTimer);
                this.confirmTimer = setTimeout(() => {
                    this.pending = null;
                    this.render();
                }, CONFIRM_TIMEOUT_MS);
            } else if (action === 'cancel') {
                this.pending = null;
            } else if (action === 'send') {
                this.pending = null;
                if (this.sendable(command, link)) {
                    this.send(command, link);
                }
            } else if (action === 'unlock' || action === 'lock') {
                this.setPyroUnlocked(action === 'unlock');
            }
            this.render();
            // The buttons were redrawn: put the focus back, on Cancel after
            // arming, so that a second Enter or Space does not send.
            const next = { arm: 'cancel', unlock: 'lock', lock: 'unlock' }[action] ?? 'arm';
            [...this.list.querySelectorAll(`button[data-action="${next}"]`)]
                .find((b) => b.dataset.command === command && b.dataset.link === link)?.focus();
        }

        setPyroUnlocked(unlocked) {
            this.pyroUnlocked = unlocked;
            clearTimeout(this.lockTimer);
            if (unlocked) {
                this.lockTimer = setTimeout(() => {
                    this.setPyroUnlocked(false);
                    this.render();
                }, PYRO_UNLOCK_MS);
            } else if (PYRO_COMMANDS.has(this.pending?.split('@')[0])) {
                this.pending = null;
            }
        }

        /** Whether `command` may go out over `link` now: the link is up, and a pyro command is unlocked. */
        sendable(command, link) {
            return this.linkUp(link) && (!PYRO_COMMANDS.has(command) || this.pyroUnlocked);
        }

        /** The arguments typed for `name`, as numbers: `{ args }`, or `{ error }` when one is missing. */
        argsFor(name) {
            const params = this.available.find((c) => c.name === name)?.params ?? {};
            const args = {};
            for (const param of Object.keys(params)) {
                const text = String(this.args[name]?.[param] ?? '').trim();
                if (text === '' || !Number.isInteger(Number(text))) {
                    return { error: `enter ${param} (${params[param]})` };
                }
                args[param] = Number(text);
            }

            return { args };
        }

        async send(name, link) {
            this.result.className = 'sp-cmd__result';
            this.result.textContent = `Sending ${name}…`;
            const { args = {} } = this.argsFor(name);
            try {
                await window.StarPi.api('/commands', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, args, link })
                });
                this.result.classList.add('is-ok');
                const shown = Object.entries(args).map(([k, v]) => `${k} ${v}`).join(', ');
                this.result.textContent = `${name}${shown ? ` (${shown})` : ''} sent over ${link} at ${clock(Date.now())}`;
            } catch (error) {
                this.result.classList.add('is-alarm');
                const reason = error.status === 503 ? 'rocket unreachable' : error.message;
                this.result.textContent = `${name} failed: ${reason}`;
            }
            this.poll();
        }

        /** The available commands, one entry each with the links that offer it, in the backend's order. */
        commands() {
            const byName = new Map();
            for (const { name, description, params, link } of this.available) {
                if (!byName.has(name)) {
                    byName.set(name, { name, description, params: params ?? {}, links: [] });
                }
                byName.get(name).links.push(link);
            }

            return [...byName.values()];
        }

        row(command) {
            const pyro = PYRO_COMMANDS.has(command.name);
            const name = escapeHtml(command.name);
            const armed = command.links.find((l) => this.pending === `${command.name}@${l}` && this.sendable(command.name, l));
            let actions;
            if (armed !== undefined) {
                const data = `data-command="${name}" data-link="${escapeHtml(armed)}"`;
                const caution = CAUTIONS[command.name] ? ` ${escapeHtml(CAUTIONS[command.name])}` : '';
                actions = `<span class="sp-cmd__confirm">${pyro ? 'Fire' : 'Send'} over ${escapeHtml(armed)}?${caution}</span>
                    <button type="button" class="c-button c-button--major sp-cmd__danger" data-action="send" ${data}>${pyro ? 'Fire' : 'Confirm'}</button>
                    <button type="button" class="c-button" data-action="cancel" ${data}>Cancel</button>`;
            } else {
                actions = `<span class="sp-cmd__link">Send via</span>${command.links.map((l) => {
                    const link = escapeHtml(l);
                    const why = !this.linkUp(l) ? `${link} link is down`
                        : pyro && !this.pyroUnlocked ? 'Unlock the pyro commands first' : '';

                    return `<button type="button" class="c-button" data-action="arm" data-command="${name}" data-link="${link}"
                        ${why ? 'disabled' : ''} title="${why}">${link}…</button>`;
                }).join('')}`;
            }

            const inputs = Object.entries(command.params).map(([param, hint]) => `<label class="sp-cmd__param">
                    ${escapeHtml(param)}
                    <input type="number" step="1" inputmode="numeric" data-command="${name}" data-param="${escapeHtml(param)}"
                        title="${escapeHtml(hint)}">
                </label>`).join('');

            return `<li class="sp-cmd__item">
                <div class="sp-cmd__text">
                    <code>${name}</code>
                    <p>${escapeHtml(command.description)}</p>
                    ${inputs}
                </div>
                <div class="sp-cmd__actions">${actions}</div>
            </li>`;
        }

        listHtml() {
            if (!this.available.length) {
                return `<p class="sp-cmd__empty">${window.StarPi.station.ok ? 'No link offers commands.' : 'Backend unreachable.'}</p>`;
            }
            const commands = this.commands();
            const pyro = commands.filter((c) => PYRO_COMMANDS.has(c.name));
            const others = commands.filter((c) => !PYRO_COMMANDS.has(c.name));
            const rows = (list) => `<ul class="sp-cmd__list">${list.map((c) => this.row(c)).join('')}</ul>`;

            return (pyro.length ? `<section class="sp-cmd__pyro${this.pyroUnlocked ? ' is-unlocked' : ''}" aria-label="Pyro commands">
                    <div class="sp-cmd__pyro-head">
                        <div>
                            <h4 class="sp-cmd__pyro-title">Pyro · ${this.pyroUnlocked ? 'unlocked' : 'locked'}</h4>
                            <p>These fire charges on the rocket.${this.pyroUnlocked ? ` Locks again ${PYRO_UNLOCK_MS / 1000} s after unlocking.` : ''}</p>
                        </div>
                        <button type="button" class="c-button" data-action="${this.pyroUnlocked ? 'lock' : 'unlock'}">${this.pyroUnlocked ? 'Lock' : 'Unlock…'}</button>
                    </div>
                    ${rows(pyro)}
                </section>` : '')
                + (others.length ? rows(others) : '');
        }

        render() {
            if (this.destroyed) {
                return;
            }
            // Only when something changed: redrawing on every health poll
            // would take the focus, and a click in progress, from the buttons.
            const html = this.listHtml();
            if (html !== this.drawn) {
                this.drawn = html;
                this.list.innerHTML = html;
                // Typed values are not in the html (a keystroke would redraw
                // the input under the cursor): put them back after a redraw.
                for (const input of this.list.querySelectorAll('input[data-param]')) {
                    input.value = this.args[input.dataset.command]?.[input.dataset.param] ?? '';
                }
            }

            this.historyList.innerHTML = this.history.length
                ? this.history.map((c) => `<li>
                    <time>${clock(c.created_at_us / 1000)}</time>
                    <span><code>${escapeHtml(c.name)}</code>${c.link ? ` <span class="sp-cmd__link">via ${escapeHtml(c.link)}</span>` : ''}</span>
                    <span class="sp-cmd__status ${c.status === 'sent' ? 'is-ok' : c.status === 'failed' ? 'is-alarm' : ''}"
                          title="${escapeHtml(c.error || '')}">${escapeHtml(c.status)}</span>
                  </li>`).join('')
                : '<li class="sp-cmd__empty">No commands sent yet.</li>';
        }
    }

    window.StarPiCommandsPanel = CommandsPanel;

    /** The "Commands" object type and its view. */
    window.StarPiCommands = function StarPiCommands() {
        return function install(openmct) {
            openmct.types.addType('starpi.commands', {
                name: 'Commands',
                description: 'Send commands to the rocket, with confirmation.',
                cssClass: 'icon-command'
            });
            openmct.objectViews.addProvider({
                key: 'starpi.commands-view',
                name: 'Commands',
                cssClass: 'icon-command',
                canView: (domainObject) => domainObject.type === 'starpi.commands',
                view() {
                    let panel;

                    return {
                        show(element) {
                            panel = new CommandsPanel(element);
                        },
                        destroy() {
                            panel?.destroy();
                        }
                    };
                }
            });
        };
    };
}());
