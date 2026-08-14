# SD WebUI Restore

SD WebUI Forge extension that automatically saves and restores the state of the
UI: prompts, negative prompt, sampler, steps, seed, models, active tab,
accordions and scroll position — across page reloads and restarts. It also
provides named presets ("workspaces") for manual save/load of full UI states.

## Installation

1. Go into Extensions tab > Install from URL
2. Paste `https://github.com/otacoo/sd-webui-restore.git`
3. Press Install
4. Apply and Restart the UI

## Info

- **Autosave** - every control change (prompt, negative prompt, sampler, steps,
  seed, batch size, checkpoints, ...) is saved to `state/session.json` after a
  short debounce, and flushed on tab change, scroll, page unload and shutdown.
- **Restore on startup** - the last session is applied on page load: prompts,
  models, active tab, accordion state and scroll position.
- **Presets** - the floating *Presets* panel (bottom-right corner) lets you
  save the current UI state under a name, load it back at any time, and delete
  it. Presets are stored as JSON files in `state/workspaces`.
- **History** - optional periodic snapshots (plus one on shutdown) in
  `state/history`; disabled by default to avoid disk writes.
- **Status toast** - a small pill confirms saves and restores; can be toggled
  off in Settings.

## Settings

All options live in Forge's Settings tab under **Restore**:

- Enable/disable the extension, autosave and autosave delay
- Which categories to restore: prompts, models, extension settings, active
  tab, accordions, scroll position
- History snapshots (default off) and snapshot interval
- Ignore tab: checkboxes per UI tab (txt2img, img2img, Extras, PNG Info, ...)
  to exclude all of a tab's controls from capture and restore. Settings and
  Extensions tabs are always excluded
- State file location
- Show status toast

## Troubleshooting

- **Settings don't seem to apply** - JS-side settings apply on the next page
  reload; Python-side settings (e.g. history) require a UI restart.
- **Nothing is saved** - make sure the extension is enabled, the page was
  reloaded after installing, and check the status toast for errors.
- **Too many disk writes** - keep history disabled, and consider disabling the
  scroll restore option (scroll tracking triggers saves on every scroll).
- **A specific control is restored wrongly or not at all** - controls are
  keyed by their nearest stable element id; if two controls share a wrapper id
  they collapse into one. Use the ignore list to exclude specific keys.
