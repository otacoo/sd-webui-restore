(function () {
    var NS = window.sdRestore || (window.sdRestore = {});

    var API = {
        base: "/sd-webui-restore",
        request: function (method, path, body) {
            var opts = { method: method, headers: {} };
            if (body !== undefined) {
                opts.headers["Content-Type"] = "application/json";
                opts.body = JSON.stringify(body);
            }
            return fetch(API.base + path, opts).then(function (res) {
                if (!res.ok) throw new Error("sd-webui-restore: HTTP " + res.status);
                return res.json();
            });
        },
        get: function (path) { return API.request("GET", path); },
        post: function (path, body) { return API.request("POST", path, body); },
        del: function (path) { return API.request("DELETE", path); }
    };

    var DEBUG = true;

    var CONFIG_DEFAULTS = {
        enabled: true,
        restore_on_start: true,
        autosave: true,
        autosave_delay: 5000,
        restore_prompts: true,
        restore_models: true,
        restore_extensions: true,
        restore_settings: false,
        restore_tab: true,
        restore_accordions: true,
        restore_scroll: true,
        show_status_toast: true,
        ignore_keys: [],
        ignore_categories: []
    };

    var TAB_CATEGORIES = [
        { id: "txt2img", label: "txt2img", pattern: /^txt2img_/i },
        { id: "img2img", label: "img2img", pattern: /^img2img_/i },
        { id: "extras", label: "Extras", pattern: /^extras_/i },
        { id: "pnginfo", label: "PNG Info", pattern: /^pnginfo_/i },
        { id: "modelmerger", label: "Checkpoint Merger", pattern: /^modelmerger_/i }
    ];

    var ALWAYS_IGNORED = /^setting_|extension/i;

    var GENERIC_TESTIDS = [
        "textbox", "checkbox", "number", "range", "slider", "select", "radio",
        "number-input", "min-input", "max-input", "button", "dropdown", "file",
        "gallery", "image", "video", "audio", "dataframe", "json", "code",
        "html", "markdown", "label", "colorpicker", "date", "time", "state",
        "accordion", "tab", "tab-item", "upload", "progress", "chatbot", "dataset"
    ];

    var state = {
        config: Object.assign({}, CONFIG_DEFAULTS),
        session: null,
        registry: new Map(),
        dirty: false,
        saving: false,
        restoring: false,
        saveTimer: null,
        booted: false
    };

    function controlType(el) {
        var tag = el.tagName;
        if (tag === "DETAILS") return "details";
        if (tag === "SELECT") return "select";
        if (tag === "TEXTAREA") return "textarea";
        if (tag === "INPUT") {
            var t = (el.type || "").toLowerCase();
            if (t === "checkbox") return "checkbox";
            if (t === "radio") return "radio";
            if (t === "range") return "range";
            if (t === "number") return "number";
            return "text";
        }
        return null;
    }

    function isCandidate(el) {
        if (el.dataset.sdRestore) return false;
        var t = controlType(el);
        if (!t) return false;
        if (el.tagName === "INPUT") {
            var type = (el.type || "").toLowerCase();
            if (type === "hidden" || type === "submit" || type === "button" || type === "file") return false;
        }
        return true;
    }

    function isStableId(id) {
        if (!id) return false;
        if (/^(range_id_|component-)\d+/.test(id)) return false;
        if (/^(gradio|generated)-/.test(id)) return false;
        return true;
    }

    function slugify(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    function labelOf(el) {
        var label = null;
        var id = el.getAttribute("id");
        if (id) {
            var forLabel = document.querySelector('label[for="' + id + '"]');
            if (forLabel) label = forLabel.textContent.trim();
        }
        if (!label) {
            var aria = el.getAttribute("aria-label");
            if (aria) label = aria.trim();
        }
        if (!label) {
            var wrap = el.closest(".label-wrap");
            if (wrap) label = wrap.textContent.trim();
        }
        if (!label) {
            var parent = el.parentElement;
            var lbl = parent && parent.querySelector ? parent.querySelector("label") : null;
            if (lbl) label = lbl.textContent.trim();
        }
        return label ? label.slice(0, 64) : null;
    }

    function keyOf(el) {
        var own = el.getAttribute("elem_id") || el.getAttribute("id") || "";
        if (isStableId(own)) return own;
        var node = el.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            var aid = node.getAttribute("elem_id") || node.getAttribute("id") || "";
            if (isStableId(aid)) return aid;
            node = node.parentElement;
        }
        var testid = el.getAttribute("data-testid");
        if (testid && GENERIC_TESTIDS.indexOf(testid) < 0) return testid;
        var label = labelOf(el);
        if (label) return slugify(label);
        return null;
    }

    function readValue(el) {
        var t = controlType(el);
        if (t === "details") return el.open;
        if (t === "checkbox") return el.checked;
        if (t === "radio") return el.checked ? el.value : null;
        return el.value;
    }

    function fire(el, name) {
        var e = new Event(name, { bubbles: true });
        Object.defineProperty(e, "target", { value: el });
        el.dispatchEvent(e);
    }

    function updateInput(el) {
        if (typeof window.updateInput === "function") {
            window.updateInput(el);
        } else {
            fire(el, "input");
        }
    }

    function writeValue(el, value) {
        var t = controlType(el);
        if (t === "details") {
            el.open = !!value;
            var id = el.getAttribute("id") || el.getAttribute("elem_id") || "";
            var checkbox = null;
            if (id) {
                try {
                    checkbox = document.querySelector("#" + id + "-checkbox input");
                } catch (e) {}
            }
            if (checkbox && checkbox.type === "checkbox") {
                checkbox.checked = !!value;
                updateInput(checkbox);
            }
            return;
        }
        if (t === "checkbox" || t === "radio") {
            if (t === "radio" && el.value !== String(value)) return;
            el.checked = !!value;
            fire(el, "change");
            if (t === "checkbox") fire(el, "input");
            return;
        }
        if (t === "select") {
            if (el.value === String(value)) return;
            el.value = value;
            fire(el, "change");
            return;
        }
        if (el.value === String(value)) return;
        el.value = value;
        updateInput(el);
    }

    function shouldIgnore(key) {
        var list = state.config.ignore_keys || [];
        if (list.indexOf(key) >= 0) return true;
        if (ALWAYS_IGNORED.test(key)) return true;
        var cats = state.config.ignore_categories || [];
        for (var i = 0; i < cats.length; i++) {
            for (var j = 0; j < TAB_CATEGORIES.length; j++) {
                if (TAB_CATEGORIES[j].id === cats[i] && TAB_CATEGORIES[j].pattern.test(key)) return true;
            }
        }
        return false;
    }

    function shouldRestoreKey(key) {
        if (/^setting_/i.test(key) && !state.config.restore_settings) return false;
        if (!state.config.restore_prompts && /(prompt|negative)/i.test(key)) return false;
        if (!state.config.restore_models && /(model|checkpoint|vae|sampler)/i.test(key)) return false;
        if (!state.config.restore_extensions && !/(prompt|negative|model|checkpoint|vae|sampler|^setting_)/i.test(key)) return false;
        return true;
    }

    function findControl(el) {
        if (el && controlType(el)) return el;
        if (el && el.querySelectorAll) {
            var found = el.querySelectorAll("input, textarea, select, details");
            for (var i = 0; i < found.length; i++) {
                if (isCandidate(found[i])) return found[i];
            }
        }
        return null;
    }

    function resolveElement(key, fallback) {
        if (fallback && fallback.isConnected) return fallback;
        var el = document.getElementById(key);
        if (el) {
            var control = findControl(el);
            if (control) return control;
        }
        return fallback;
    }

    function bind(el) {
        if (el.dataset.sdRestoreBound) return;
        el.dataset.sdRestoreBound = "1";
        if (el.tagName === "DETAILS") {
            el.addEventListener("toggle", onControlChange);
        } else {
            el.addEventListener("input", onControlChange);
            el.addEventListener("change", onControlChange);
        }
    }

    function register(el) {
        if (!isCandidate(el)) return;
        var key = keyOf(el);
        if (!key) return;
        var entry = state.registry.get(key);
        if (!entry) {
            entry = { el: el, type: controlType(el), last: undefined };
            state.registry.set(key, entry);
        } else if (entry.el !== el) {
            if (entry.el.isConnected) return;
            entry.el = el;
            entry.type = controlType(el);
            entry.last = undefined;
        }
        bind(el);
        if (state.session && state.session.controls && !entry.applied && !entry.touched) {
            applyTo(key, state.session.controls[key]);
        }
    }

    function onControlChange(e) {
        if (state.restoring) return;
        var el = e.currentTarget;
        var key = keyOf(el);
        if (!key) return;
        var entry = state.registry.get(key);
        if (!entry) return;
        var v = readValue(el);
        if (entry.last !== undefined && entry.last === v) return;
        entry.last = v;
        entry.touched = true;
        state.dirty = true;
        scheduleSave();
    }

    function scheduleSave() {
        if (!state.config.enabled || !state.config.autosave) return;
        clearTimeout(state.saveTimer);
        var delay = Math.max(150, Number(state.config.autosave_delay) || 5000);
        state.saveTimer = setTimeout(save, delay);
    }

    function capture() {
        var fresh = document.querySelectorAll("input, textarea, select, details");
        for (var i = 0; i < fresh.length; i++) register(fresh[i]);
        var controls = {};
        state.registry.forEach(function (entry, key) {
            if (shouldIgnore(key)) return;
            try {
                var el = resolveElement(key, entry.el);
                if (el !== entry.el) {
                    entry.el = el;
                    entry.last = undefined;
                    bind(el);
                }
                controls[key] = readValue(el);
            } catch (e) {}
        });
        return {
            saved: new Date().toISOString(),
            controls: controls,
            ui: {
                tab: currentTab(),
                scroll: window.scrollY || 0,
                accordions: captureAccordions()
            },
            metadata: {}
        };
    }

    function captureAccordions() {
        var out = {};
        state.registry.forEach(function (entry, key) {
            if (entry.type === "details") out[key] = entry.el.open;
        });
        var all = document.querySelectorAll("details");
        for (var i = 0; i < all.length; i++) {
            var k = keyOf(all[i]);
            if (k && out[k] === undefined) out[k] = all[i].open;
        }
        return out;
    }

    function currentTab() {
        var tab = document.querySelector('[role="tab"][aria-selected="true"]') ||
                  document.querySelector(".tab-nav button.selected") ||
                  document.querySelector('[aria-selected="true"][role="tab"]');
        if (!tab) return null;
        var id = tab.getAttribute("elem_id") || tab.getAttribute("id") || tab.getAttribute("aria-label");
        return id || labelOf(tab);
    }

    function save() {
        if (!state.dirty || state.saving || !state.config.enabled) return;
        state.dirty = false;
        state.saving = true;
        var snapshot = capture();
        API.post("/state", { state: snapshot }).then(function () {
            state.saving = false;
            showStatus("saved: " + Object.keys(snapshot.controls || {}).length + " controls");
        }).catch(function () {
            state.dirty = true;
            state.saving = false;
        });
    }

    function flush() {
        clearTimeout(state.saveTimer);
        if (state.dirty) save();
    }

    function priorityOf(key) {
        if (/(prompt|negative|cfg|steps|seed|batch|denoise|sampler|width|height)/i.test(key)) return 0;
        if (/(model|checkpoint|vae|lor|lora|hires)/i.test(key)) return 1;
        return 2;
    }

    function orderKeys(keys) {
        return keys.slice().sort(function (a, b) {
            return priorityOf(a) - priorityOf(b);
        });
    }

    function restoreTab(tabId) {
        if (!tabId) return;
        var el = document.querySelector('[data-testid="' + tabId + '"]') ||
                 document.getElementById(tabId) ||
                 document.querySelector('[aria-label="' + tabId + '"]');
        if (el && typeof el.click === "function") el.click();
    }

    function restoreUi(ui) {
        if (!ui) return;
        try {
            if (state.config.restore_tab && ui.tab) restoreTab(ui.tab);
            if (state.config.restore_accordions && ui.accordions) {
                Object.keys(ui.accordions).forEach(function (key) {
                    try {
                        var entry = state.registry.get(key);
                        if (entry && entry.type === "details") writeValue(entry.el, !!ui.accordions[key]);
                    } catch (e) {}
                });
            }
            if (state.config.restore_scroll && typeof ui.scroll === "number") {
                setTimeout(function () { window.scrollTo(0, ui.scroll); }, 300);
            }
        } catch (e) {}
    }

    function restore() {
        return API.get("/state").then(function (session) {
            state.session = session;
            if (!session || !session.controls) return;
            try {
                state.restoring = true;
                var controls = session.controls || {};
                orderKeys(Object.keys(controls)).forEach(function (key) {
                    applyTo(key, controls[key]);
                });
                restoreUi(session.ui);
            } finally {
                setTimeout(function () { state.restoring = false; }, 300);
            }
        }).catch(function () {
            state.session = null;
        });
    }

    function applyTo(key, value, force) {
        if (value === undefined || value === null) return false;
        if (shouldIgnore(key)) return false;
        if (!force && !shouldRestoreKey(key)) return false;
        var entry = state.registry.get(key);
        var el = entry ? resolveElement(key, entry.el) : null;
        if (!el) {
            var candidate = document.getElementById(key);
            if (candidate) {
                var control = findControl(candidate);
                if (control) {
                    register(control);
                    entry = state.registry.get(key);
                    el = entry ? entry.el : null;
                }
            }
        }
        if (!el || !entry) return false;
        try {
            writeValue(el, value);
            entry.last = readValue(el);
            entry.applied = true;
            return true;
        } catch (e) {
            if (DEBUG) console.warn("sd-restore: failed to apply '" + key + "'", e);
            return false;
        }
    }

    function scanNode(root) {
        if (root.querySelectorAll) {
            var found = root.querySelectorAll("input, textarea, select, details");
            for (var i = 0; i < found.length; i++) register(found[i]);
        }
        if (root.tagName && controlType(root)) register(root);
    }

    function startObserving() {
        var mo = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var node = m.addedNodes[j];
                    if (node.nodeType !== 1) continue;
                    scanNode(node);
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    function trackTabChanges() {
        document.addEventListener("click", function (e) {
            var target = e.target;
            var btn = target && target.closest ? target.closest('button, [role="tab"]') : null;
            if (!btn) return;
            var isTab = btn.getAttribute("role") === "tab" || (btn.closest && btn.closest('[role="tablist"]'));
            if (isTab) {
                state.dirty = true;
                scheduleSave();
            }
        }, true);
    }

    function trackScroll() {
        window.addEventListener("scroll", function () {
            if (state.booted && !state.restoring && state.config.restore_scroll) {
                state.dirty = true;
                scheduleSave();
            }
        }, { passive: true });
    }

    function showStatus(text) {
        try {
            if (!state.config.show_status_toast) return;
            var el = document.getElementById("sd-webui-restore-status");
            if (!el) {
                el = document.createElement("div");
                el.id = "sd-webui-restore-status";
                document.body.appendChild(el);
            }
            el.textContent = text;
            el.classList.add("show");
            clearTimeout(showStatus._timer);
            showStatus._timer = setTimeout(function () { el.classList.remove("show"); }, 2500);
        } catch (e) {}
    }

    function applyControls(controls, ui) {
        var keys = orderKeys(Object.keys(controls || {}));
        var failed = [];
        state.restoring = true;
        try {
            keys.forEach(function (key) {
                if (!applyTo(key, controls[key], true)) failed.push(key);
            });
            restoreUi(ui);
        } finally {
            setTimeout(function () {
                state.restoring = false;
                state.dirty = true;
                scheduleSave();
            }, 1200);
        }
        if (failed.length) {
            setTimeout(function () {
                failed.forEach(function (key) { applyTo(key, controls[key], true); });
            }, 900);
        }
        return failed.length === 0;
    }

    function boot() {
        if (state.booted || state.starting) return;
        state.starting = true;
        API.get("/config").then(function (cfg) {
            state.config = Object.assign({}, CONFIG_DEFAULTS, cfg || {});
            return cfg;
        }).catch(function () {
            return null;
        }).then(function () {
            if (!state.config.enabled) return;
            scanNode(document);
            startObserving();
            trackTabChanges();
            trackScroll();
            return restore();
        }).then(function () {
            state.booted = true;
            var count = state.session && state.session.controls ? Object.keys(state.session.controls).length : 0;
            if (DEBUG) console.info("sd-restore: booted, registry=" + state.registry.size + ", session controls=" + count);
            showStatus("restored: " + count + " controls");
            window.addEventListener("beforeunload", flush);
            document.addEventListener("visibilitychange", function () {
                if (document.visibilityState === "hidden") flush();
            });
        });
    }

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn);
        } else {
            fn();
        }
    }

    function start() {
        var promptReady = !!document.getElementById("txt2img_prompt");
        if (promptReady) {
            boot();
        } else if (typeof onUiLoaded === "function") {
            onUiLoaded(boot);
            setTimeout(function () {
                if (!state.booted) boot();
            }, 4000);
        } else {
            ready(function () { setTimeout(boot, 250); });
        }
    }

    ready(function () {
        setTimeout(start, 100);
    });

    NS.boot = boot;
    NS.capture = capture;
    NS.save = save;
    NS.restore = restore;
    NS.api = API;
    NS.getRegistry = function () { return state.registry; };
    NS.status = showStatus;
    NS.listWorkspaces = function () { return API.get("/workspaces"); };
    NS.saveWorkspace = function (name) {
        return API.post("/workspaces/" + encodeURIComponent(name), { state: capture() });
    };
    NS.loadWorkspace = function (name) {
        return API.get("/workspaces/" + encodeURIComponent(name)).then(function (data) {
            return applyControls(data.controls || {}, data.ui);
        });
    };
    NS.deleteWorkspace = function (name) {
        return API.del("/workspaces/" + encodeURIComponent(name));
    };
})();
