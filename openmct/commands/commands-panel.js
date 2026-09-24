/*
 * Command panel: the commands the connected links accept, each behind a
 * confirm step, plus the recent command history. Open MCT has no commanding
 * UI of its own without YAMCS, so this is a small custom view: the "Commands"
 * object (addable to any Display Layout), also embedded in Launch Control.
 */
(function () {
    const POLL_MS = 5000;
    const CONFIRM_TIMEOUT_MS = 8000;
    // raw_write can write anything anywhere: API only, never a button.
    const HIDDEN_COMMANDS = new Set(['raw_write']);

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
            this.inFlight = false;

            element.innerHTML = `
                <div class="sp-cmd">
                    <ul class="sp-cmd__list" data-ref="list"></ul>
                    <p class="sp-cmd__result" data-ref="result" role="status"></p>
                    <h4 class="sp-cmd__heading">Recent</h4>
                    <ol class="sp-cmd__history" data-ref="history"></ol>
                </div>`;
            this.list = element.querySelector('[data-ref="list"]');
            this.result = element.querySelector('[data-ref="result"]');
            this.historyList = element.querySelector('[data-ref="history"]');
            this.list.addEventListener('click', (event) => this.onClick(event));

            this.offStation = window.StarPi.station.onStatus(() => this.render());
            this.poll();
            this.timer = setInterval(() => this.poll(), POLL_MS);
        }

        destroy() {
            this.destroyed = true;
            clearInterval(this.timer);
            clearTimeout(this.confirmTimer);
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
                this.send(command, link);
            }
            this.render();
            this.list.querySelector('button[data-action]:not([disabled])')?.focus();
        }

        async send(name, link) {
            this.result.className = 'sp-cmd__result';
            this.result.textContent = `Sending ${name}…`;
            try {
                await window.StarPi.api('/commands', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, args: {}, link })
                });
                this.result.classList.add('is-ok');
                this.result.textContent = `${name} sent over ${link} at ${clock(Date.now())}`;
            } catch (error) {
                this.result.classList.add('is-alarm');
                const reason = error.status === 503 ? 'rocket unreachable' : error.message;
                this.result.textContent = `${name} failed: ${reason}`;
            }
            this.poll();
        }

        render() {
            if (this.destroyed) {
                return;
            }
            if (!this.available.length) {
                this.list.innerHTML = `<li class="sp-cmd__empty">${window.StarPi.station.ok ? 'No link offers commands.' : 'Backend unreachable.'}</li>`;
            } else {
                this.list.innerHTML = this.available.map((command) => {
                    const up = this.linkUp(command.link);
                    const name = escapeHtml(command.name);
                    const link = escapeHtml(command.link);
                    const data = `data-command="${name}" data-link="${link}"`;
                    const actions = this.pending === `${command.name}@${command.link}` && up
                        ? `<span class="sp-cmd__confirm">Send to the rocket?</span>
                           <button type="button" class="c-button c-button--major sp-cmd__danger" data-action="send" ${data}>Confirm</button>
                           <button type="button" class="c-button" data-action="cancel" ${data}>Cancel</button>`
                        : `<button type="button" class="c-button" data-action="arm" ${data} ${up ? '' : 'disabled'}
                             title="${up ? '' : `${link} link is down`}">Send…</button>`;

                    return `<li class="sp-cmd__item">
                        <div class="sp-cmd__text">
                            <code>${name}</code> <span class="sp-cmd__link">via ${link}</span>
                            <p>${escapeHtml(command.description)}</p>
                        </div>
                        <div class="sp-cmd__actions">${actions}</div>
                    </li>`;
                }).join('');
            }

            this.historyList.innerHTML = this.history.length
                ? this.history.map((c) => `<li>
                    <time>${clock(c.created_at_us / 1000)}</time>
                    <code>${escapeHtml(c.name)}</code>
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
