import atexit
import json
import os
import shutil
import threading
import time
from pathlib import Path

import gradio as gr

from modules import script_callbacks, shared
from modules.options import OptionHTML

EXTENSION_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = EXTENSION_ROOT / "state"
HISTORY_LIMIT = 10

DEFAULT_CONFIG = {
    "enabled": True,
    "restore_on_start": True,
    "autosave": True,
    "autosave_delay": 5000,
    "restore_prompts": True,
    "restore_models": True,
    "restore_extensions": True,
    "restore_settings": False,
    "restore_tab": True,
    "restore_accordions": True,
    "restore_scroll": False,
    "show_status_toast": True,
    "keep_history": False,
    "history_limit": HISTORY_LIMIT,
    "ignore_keys": [],
    "ignore_categories": [],
    "state_location": str(STATE_DIR),
}

PREFIX = "sd_restore"

OPTION_MAPPING = {
    "enabled": PREFIX + "_enabled",
    "autosave": PREFIX + "_autosave",
    "restore_on_start": PREFIX + "_restore_on_start",
    "autosave_delay": PREFIX + "_autosave_delay",
    "restore_prompts": PREFIX + "_restore_prompts",
    "restore_models": PREFIX + "_restore_models",
    "restore_extensions": PREFIX + "_restore_extensions",
    "restore_settings": PREFIX + "_restore_settings",
    "restore_tab": PREFIX + "_restore_tab",
    "restore_accordions": PREFIX + "_restore_accordions",
    "restore_scroll": PREFIX + "_restore_scroll",
    "show_status_toast": PREFIX + "_show_status_toast",
    "ignore_categories": PREFIX + "_ignore_categories",
    "keep_history": PREFIX + "_keep_history",
    "state_location": PREFIX + "_state_location",
}

COMPONENT_METADATA = []


def configured_state_dir():
    try:
        loc = shared.opts.get(PREFIX + "_state_location", None)
    except Exception:
        loc = None
    if not loc:
        return STATE_DIR
    return Path(str(loc))


def session_path():
    return configured_state_dir() / "session.json"


def history_dir():
    return configured_state_dir() / "history"


def workspaces_dir():
    return configured_state_dir() / "workspaces"


def ensure_dirs():
    for path in (configured_state_dir(), history_dir(), workspaces_dir()):
        path.mkdir(parents=True, exist_ok=True)


def read_json(path, default=None):
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return dict(default) if default is not None else {}


def write_json(path, data):
    ensure_dirs()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def config_from_opts():
    cfg = dict(DEFAULT_CONFIG)
    for key, opt in OPTION_MAPPING.items():
        try:
            value = shared.opts.get(opt, None)
            if value is not None:
                cfg[key] = value
        except Exception:
            pass
    return cfg


def load_config():
    return config_from_opts()


def load_session():
    return read_json(session_path(), {})


def prune_history(limit=None):
    if limit is None:
        limit = load_config().get("history_limit", HISTORY_LIMIT)
    if limit <= 0:
        return
    files = sorted(history_dir().glob("*.json"))
    for old in files[:-limit]:
        try:
            old.unlink()
        except Exception:
            pass


LAST_SNAPSHOT_TIME = 0.0
SNAPSHOT_LOCK = threading.Lock()


def history_interval():
    try:
        interval = int(shared.opts.get(PREFIX + "_history_interval", 10))
    except Exception:
        interval = 10
    return max(0, interval)


def snapshot_to_history():
    if not session_path().exists():
        return
    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        shutil.copyfile(session_path(), history_dir() / f"{stamp}.json")
        prune_history()
    except Exception:
        pass


def save_session(state, history=True):
    global LAST_SNAPSHOT_TIME
    ensure_dirs()
    if history and load_config().get("keep_history", True) and history_interval() > 0:
        with SNAPSHOT_LOCK:
            now = time.time()
            if now - LAST_SNAPSHOT_TIME >= history_interval() * 60:
                snapshot_to_history()
                LAST_SNAPSHOT_TIME = now
    write_json(session_path(), state)


def on_shutdown():
    try:
        if load_config().get("keep_history", True):
            snapshot_to_history()
    except Exception:
        pass


atexit.register(on_shutdown)


def list_workspaces():
    ensure_dirs()
    return [p.stem for p in sorted(workspaces_dir().glob("*.json"))]


def load_workspace(name):
    return read_json(workspaces_dir() / f"{name}.json", {})


def save_workspace(name, state):
    write_json(workspaces_dir() / f"{name}.json", state)


def delete_workspace(name):
    path = workspaces_dir() / f"{name}.json"
    if path.exists():
        path.unlink()


def register_api(app):
    from fastapi import Request

    @app.get("/sd-webui-restore/state")
    def get_state():
        return load_session()

    @app.post("/sd-webui-restore/state")
    async def post_state(request: Request):
        payload = await request.json()
        state = payload.get("state") or {}
        workspace = payload.get("workspace")
        if workspace:
            save_workspace(str(workspace), state)
        save_session(state)
        return {"ok": True}

    @app.delete("/sd-webui-restore/state")
    def delete_state():
        write_json(session_path(), {})
        return {"ok": True}

    @app.get("/sd-webui-restore/config")
    def get_config():
        return load_config()

    @app.get("/sd-webui-restore/metadata")
    def get_metadata():
        return {"components": COMPONENT_METADATA}

    @app.get("/sd-webui-restore/workspaces")
    def get_workspaces():
        return {"workspaces": list_workspaces()}

    @app.get("/sd-webui-restore/workspaces/{name}")
    def get_workspace(name: str):
        return load_workspace(name)

    @app.post("/sd-webui-restore/workspaces/{name}")
    async def post_workspace(name: str, request: Request):
        payload = await request.json()
        save_workspace(name, payload.get("state") or {})
        return {"ok": True}

    @app.delete("/sd-webui-restore/workspaces/{name}")
    def delete_workspace_endpoint(name: str):
        delete_workspace(name)
        return {"ok": True}


PRESETS_HTML = """
<div id="sd-webui-restore-presets-block">
    <div class="sr-block-title">Presets</div>
    <div class="sr-block-row">
        <input id="sr-presets-name" placeholder="preset name" maxlength="64"/>
        <button id="sr-presets-save" class="gradio-button secondary-button">Save current</button>
    </div>
    <div class="sr-block-row">
        <select id="sr-presets-list"></select>
        <button id="sr-presets-load" class="gradio-button secondary-button">Load</button>
        <button id="sr-presets-delete" class="gradio-button secondary-button">Delete</button>
    </div>
</div>
<script>
(function () {
    var root = document.getElementById("sd-webui-restore-presets-block");
    if (!root || root.dataset.bound === "1") return;
    root.dataset.bound = "1";
    var api = window.sdRestore || {};
    var nameInput = document.getElementById("sr-presets-name");
    var list = document.getElementById("sr-presets-list");
    function fill(res) {
        var names = (res && res.workspaces) || [];
        list.textContent = "";
        if (!names.length) {
            var opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no presets)";
            list.appendChild(opt);
        }
        for (var i = 0; i < names.length; i++) {
            var opt = document.createElement("option");
            opt.value = names[i];
            opt.textContent = names[i];
            list.appendChild(opt);
        }
    }
    function refresh() {
        api.listWorkspaces().then(fill).catch(function () {});
    }
    document.getElementById("sr-presets-save").addEventListener("click", function () {
        var name = nameInput.value.trim();
        if (!name) { if (api.status) api.status("enter a preset name first"); return; }
        api.saveWorkspace(name).then(function () {
            if (api.status) api.status("saved preset: " + name);
            nameInput.value = "";
            refresh();
        }).catch(function () { if (api.status) api.status("failed to save preset"); });
    });
    document.getElementById("sr-presets-load").addEventListener("click", function () {
        var name = list.value;
        if (!name) return;
        api.loadWorkspace(name).then(function (ok) {
            if (api.status) api.status("loaded preset: " + name + (ok ? "" : " (some controls pending)"));
        }).catch(function () { if (api.status) api.status("failed to load preset"); });
    });
    document.getElementById("sr-presets-delete").addEventListener("click", function () {
        var name = list.value;
        if (!name || !confirm("Delete preset '" + name + "'?")) return;
        api.deleteWorkspace(name).then(function () {
            if (api.status) api.status("deleted preset: " + name);
            refresh();
        }).catch(function () { if (api.status) api.status("failed to delete preset"); });
    });
    refresh();
})();
</script>
"""


def on_ui_settings():
    section = ("sd-restore", "Restore")
    shared.opts.add_option(PREFIX + "_enabled", shared.OptionInfo(True, "Enable SD WebUI Restore", section=section))
    shared.opts.add_option(PREFIX + "_show_status_toast", shared.OptionInfo(True, "Show status toast", section=section))
    shared.opts.add_option(PREFIX + "_autosave", shared.OptionInfo(True, "Enable autosave (save on every change)", section=section))
    shared.opts.add_option(PREFIX + "_restore_on_start", shared.OptionInfo(True, "Restore previous session on startup", section=section))
    shared.opts.add_option(PREFIX + "_autosave_delay", shared.OptionInfo(5000, "Autosave delay in milliseconds", section=section))
    shared.opts.add_option(PREFIX + "_restore_prompts", shared.OptionInfo(True, "Restore prompts", section=section))
    shared.opts.add_option(PREFIX + "_restore_models", shared.OptionInfo(True, "Restore selected models", section=section))
    shared.opts.add_option(PREFIX + "_restore_extensions", shared.OptionInfo(True, "Restore extension settings", section=section))
    shared.opts.add_option(PREFIX + "_restore_tab", shared.OptionInfo(True, "Restore active tab", section=section))
    shared.opts.add_option(PREFIX + "_restore_accordions", shared.OptionInfo(True, "Restore accordion state", section=section))
    shared.opts.add_option(PREFIX + "_restore_scroll", shared.OptionInfo(False, "Restore scroll position", section=section, infotext="Requires a reload of the UI to take effect and can cause a lot of writes.").info("requires a reload of the UI to take effect; can cause a lot of writes"))
    shared.opts.add_option(PREFIX + "_keep_history", shared.OptionInfo(False, "Keep session history snapshots", section=section, infotext="Requires a reload of the UI to take effect and can cause a lot of writes.").info("requires a reload of the UI to take effect; can cause a lot of writes"))
    shared.opts.add_option(PREFIX + "_history_interval", shared.OptionInfo(10, "History snapshot interval in minutes (0 = only on shutdown)", section=section))
    shared.opts.add_option(
        PREFIX + "_ignore_categories",
        shared.OptionInfo(
            [],
            "Ignore tab",
            component=gr.CheckboxGroup,
            component_args={"choices": [
                ("txt2img", "txt2img"),
                ("img2img", "img2img"),
                ("Extras", "extras"),
                ("PNG Info", "pnginfo"),
                ("Checkpoint Merger", "modelmerger"),
            ]},
            section=section,
        ).info("uncheck a tab to exclude all of its controls from capture and restore"),
    )
    shared.opts.add_option(PREFIX + "_state_location", shared.OptionInfo(str(STATE_DIR), "State file location", section=section))
    presets_option = OptionHTML(PRESETS_HTML)
    presets_option.section = section
    shared.opts.add_option(PREFIX + "_presets_html", presets_option)


def on_before_component(component, **kwargs):
    try:
        elem_id = kwargs.get("elem_id")
        label = kwargs.get("label")
        if not elem_id and not label:
            return
        COMPONENT_METADATA.append({
            "elem_id": elem_id,
            "label": label,
            "type": getattr(component, "__name__", str(component)),
        })
    except Exception:
        pass


def on_app_started(demo, app):
    ensure_dirs()
    register_api(app)


script_callbacks.on_ui_settings(on_ui_settings)
script_callbacks.on_before_component(on_before_component)
script_callbacks.on_app_started(on_app_started)
