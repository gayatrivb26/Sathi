/* Sathi - Hangfire dashboard tweaks (contract section 11.10). Embedded resource, appended to the dashboard's JS bundle. */
(function () {
    'use strict';

    var STORAGE_KEY = 'sathi.hangfire.autoRefresh';
    var REFRESH_MS = 10000;
    var CHART_HEIGHT = 220;

    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    // ---------------- graphs: about 220 px high, redrawn (not squashed) ----------------

    function limitGraphs() {
        ['realtimeGraph', 'historyGraph'].forEach(function (id) {
            var canvas = document.getElementById(id);
            if (!canvas || (canvas.parentNode && canvas.parentNode.className === 'sathi-chart')) return;
            var wrapper = document.createElement('div');
            wrapper.className = 'sathi-chart';
            canvas.parentNode.insertBefore(wrapper, canvas);
            wrapper.appendChild(canvas);
        });

        var Chart = window.Chart;
        if (!Chart || !Chart.instances) return false;
        var found = false;
        Object.keys(Chart.instances).forEach(function (key) {
            var chart = Chart.instances[key];
            if (!chart || !chart.canvas || !chart.options) return;
            if (chart.canvas.id !== 'realtimeGraph' && chart.canvas.id !== 'historyGraph') return;
            found = true;
            if (chart.options.maintainAspectRatio !== false) {
                chart.options.maintainAspectRatio = false;
                chart.resize();
            }
        });
        return found;
    }

    function limitGraphsWhenCreated() {
        // The dashboard creates its charts on page load; retry briefly until they exist.
        var tries = 0;
        (function attempt() {
            if (limitGraphs() || ++tries > 40) return;
            window.setTimeout(attempt, 250);
        })();
    }

    // ---------------- job lists: "Auto-refresh (10 s)" toggle ----------------

    function readSetting() {
        try {
            var v = window.localStorage.getItem(STORAGE_KEY);
            return v === null ? true : v === 'on'; // on by default
        } catch (e) {
            return true;
        }
    }

    function writeSetting(on) {
        try { window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
    }

    function hasSelection() {
        return document.querySelectorAll('.js-jobs-list-checkbox:checked, .js-jobs-list-select-all:checked').length > 0;
    }

    function addAutoRefresh() {
        var list = document.querySelector('.js-jobs-list');
        if (!list) return; // only job list pages

        var label = document.createElement('label');
        label.className = 'sathi-autorefresh';
        label.title = 'Reloads this list every 10 seconds while the tab is visible and nothing is selected';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = readSetting();
        var text = document.createElement('span');
        text.textContent = 'Auto-refresh (10 s)';
        var state = document.createElement('span');
        state.className = 'sathi-autorefresh-state';
        label.appendChild(box);
        label.appendChild(text);
        label.appendChild(state);

        var toolbar = list.querySelector('.btn-toolbar') || document.querySelector('.js-page-container .btn-toolbar');
        if (toolbar) toolbar.appendChild(label);
        else list.insertBefore(label, list.firstChild);

        var timer = null;

        function render() {
            var paused = box.checked && (document.hidden || hasSelection());
            label.classList.toggle('is-paused', paused);
            state.textContent = !box.checked ? '' : document.hidden ? '- paused (tab hidden)' : hasSelection() ? '- paused (selection)' : '';
        }

        function schedule() {
            if (timer) window.clearTimeout(timer);
            timer = null;
            render();
            if (!box.checked || document.hidden) return;
            timer = window.setTimeout(function () {
                if (box.checked && !document.hidden && !hasSelection()) window.location.reload();
                else schedule();
            }, REFRESH_MS);
        }

        box.addEventListener('change', function () {
            writeSetting(box.checked);
            schedule();
        });
        document.addEventListener('visibilitychange', schedule);
        list.addEventListener('change', render);
        schedule();
    }

    onReady(function () {
        limitGraphsWhenCreated();
        addAutoRefresh();
    });
})();
