# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been released yet, so the entries below carry no release dates.

## [0.4.0] — not released

### Added

- **Profile-scoped independent JSON storage**: move large flair data out of the main configuration, preserve raw and effective migration backups, and install only a lightweight file-storage marker. Opening the page never writes; cleanup requires explicit confirmation and verified, unchanged source data.
- **Durable saves and recovery boundaries**: serialized same-host saves, captured draft revision checks, atomic file replacement, idempotent operation receipts, fail-closed corrupt/missing-file behavior, and visible cleanup retries. No cross-process atomic CAS is claimed.
- **Configuration sharing**: import a configuration shared by another user as an in-page draft with a count summary; invalid or foreign documents are rejected. Custom icons travel as embedded `data:` URLs rather than file paths.
- **Storage controls**: back up the current configuration to a file, prompt for that manual backup during migration, and retain edits made while a previous save is in flight. Data polling and focus refresh synchronize browser pages. Legacy fields are no longer volatile-writable.

Version 0.4.0 is not released. No actual profile migration or service operation was performed while developing it.

### Fixed

- **Shipped-look flash before configuration arrives**: the pre-config placeholder used to paint the factory look, briefly flashing 暖金色 on load and on every hot reload. It now leaves DSH’s own styling in place until the real configuration applies.
- **Rule look overwritten by settings notifications**: a settings-mirror update while the plugin’s run flag was momentarily empty repainted the base selection. It now re-applies the matching event rule, and theme changes only repaint the preset already on screen.

## [0.3.0] — not released

### Added

- **Default-first configuration tabs and starter rules**: Default selection and Event rules and groups are sibling panels that preserve drafts while switching. Rule enable and move controls remain visible when details are collapsed. Four editable starters cover thinking/interaction, information gathering, execution/operations and replies. Each initial or newly added starter selects DSH’s own look and copy, rather than inheriting the global selection. Existing rules and explicit empty lists are preserved; adding starters fills only missing IDs, without enabling the master switch.
- **Explicit output phases**: built-in waiting, thinking and responding groups use current-attempt live stream deltas. Thinking requires explicit reasoning; responding means visible text, not necessarily a final answer. Stream and attempt boundaries, retries, navigation and recovery clear evidence instead of replaying old text. The native 14-category tool classifier remains unchanged; custom activity groups can combine the new phases, and the editor shows the current output state.
- **Event policies**: optional client-side activity and tool-result rules, disabled by default with `eventGroups: []` and `eventRules: { enabled: false, minRefreshMs: 3000 }`; missing rule lists receive four editable starters, while explicit empty lists are preserved. Activity groups follow DSH’s 14 native categories (`thinking`, `read`, `readImage`, `search`, `write`, `edit`, `commands`, `code`, `webSearch`, `webFetch`, `subagents`, `plan`, `questions`, `tools`); pulse groups use `tool-error` or `tool-success`. Built-in groups are virtual, while custom groups can match native activity categories or exact tool names; pulse tool-name filters narrow the selected result types.
- **Ordered event rules**: the first enabled, valid matching rule supplies a complete look/text `selection`, including the official `default` sentinel. Rules reference same-kind groups, inherit global `triggers` and use a configurable pulse hold window (default 2000ms). Group and rule edits retain the explicit-save draft workflow. Health diagnostics expose only group/rule counts and enablement summaries, not their contents.
- **Shared-source event lifecycle**: event policies use only the current main session’s existing shared source, without a new `follow` stream or host-side session subscriptions. History and reconnect recovery do not replay transient result pulses. Unknown extension tools can be targeted by exact name in custom groups. Version 0.3.0 has not been released.
- **Per-preset sweep colours**: each look preset can set its own shimmer colour for dark and light themes. Leaving a field empty keeps the automatic derivation (mixed toward white on dark themes, toward black on light themes), and the preset editor gains two colour rows, each with a native colour picker, a text field for any CSS colour, and a clear-to-auto button. An empty field previews the automatic colour for *its own* theme, and the rows are plain containers rather than `<label>`s so clicking the empty area cannot open the colour picker.
- **No-icon option**: a look preset can now set `icon: none`, which hides the running row's icon slot entirely (the preview omits it too) for people who do not want an icon.
- **Configurable switch timing for both layers**: the look and the copy each get their own triggers. The per-turn trigger is now a toggle too (on by default, so the historical "one draw per turn" behaviour is unchanged); turning it off keeps that layer's previous draw until another trigger fires. Two more triggers can be enabled per layer: a time trigger re-draws it on a fixed interval or on a random interval between a configured minimum and maximum, and a step trigger re-draws it every N Session `step/start` events. Steps come from contiguous live appends on the current main Session’s shared source; replayable Conversation matchers no longer mutate counters. The settings page gains a **Switch timing** card with one block per layer.

### Fixed

- **Same-turn status-row remounts**: a temporarily unmounted running row no longer ends an open session turn and forces an immediate rule redraw on return. Execution-to-thinking switches retain the configured minimum interval; actual turn end still cancels timers. DOM-based lifecycle detection remains a fallback when no live turn source is available.
- **Native Chat tool snapshot**: read running calls from `snapshot.legacy.runningCalls` instead of assuming a flat target snapshot. Root code execution and running PTC subcalls now participate in event rules. Regression fixtures use the actual nested layout, and diagnostics list detected tool categories without hardcoding plugin-specific names.
- **Runtime cleanup and compatibility**: end, navigation, disable and unload cancel rotation and pulse timers; incomplete event services roll back partial subscriptions and fall back to default selection. Late initial configuration respects disabled state and does not retain placeholder draws when per-turn refresh is off. A private copy-dictionary revision requests immediate locale-subscriber repaint without changing the language preference.
- **Shimmer ignored the light theme**: the sweep colour was always mixed toward white, so it looked washed out in light themes. It now follows the active colour scheme (mixed toward white on dark themes, toward black on light themes), reads the scheme from the `theme` service when available and repaints on `theme/change`.

## [0.2.1] — not released

### Fixed

- **Running row stayed on the placeholder config for a whole boot**: the shared settings mirror notifies subscribers with no argument, but the client read the listener's first parameter as the snapshot. Every notification after `apply()` was therefore mistaken for "not ready" and skipped, so the real profile config never reached the running row — it kept the default look with DSH's own copy until the page reloaded with the document already ready. The client now reads `form.getSnapshot()` on every notification instead of trusting the callback argument.
- **First frame showed the raw `{duration}` template**: DSH renders the running row with `chat.deepDiving` (no duration) until the turn's start time is known. The custom copy was interpolated with no parameters, so a line such as `…用时{duration}…` appeared verbatim for one frame. When the caller passes no `duration`, the line now renders with a zero duration (`0` + the chat dictionary's second unit, so `0秒` / `0s`) instead of the raw template; the real elapsed time replaces it on the next tick.
- **First turn after a page load kept DSH's own running copy**: `apply()` paints a placeholder config before the settings mirror delivers the real one. If a run started in that window, the run rolled against the placeholder and the live config was then ignored for the rest of that run — the row showed the default look with DSH's `深度求索中` copy while the settings page showed the configured presets. The first real config now re-rolls the active run once; later config changes still wait for the next run.

## [0.2.0] — not released

### Added

- **Two preset layers**: looks (colour, size, icon, shimmer) and text groups (named sets of candidate lines) are separate; each layer has its own fixed/random strategy, and the line inside a picked group uses first / random / rotate.
- **Default entries** for both layers. The default look sets no CSS variable and removes the plugin marker, so DSH renders the row itself; the default copy passes `translate` through to DSH's own `chat.deepDivingFor`. Nothing official is copied into the plugin.
- **Multi-select dropdown** for random candidates, replacing the ever-growing checkbox row: an "All" summary, select-all, and a guard against zero candidates.
- **Official whale icon**: `icon: whale` reuses the running row's APNG whale tail — resolved from DSH's injected stylesheet as a mask, so colour and size follow the preset while nothing is copied. The whale's own loop speed is baked into the APNG; the preset shimmer still controls the text sweep.
- **Custom icons**: paste `<svg>` markup or upload an SVG / transparent PNG; the icon is used as a mask (alpha shape only), so it follows the preset colour. Scripts, event attributes, `foreignObject` and external `href` values are stripped.
- **Draft + explicit save**: every adjustment lands in an in-page draft and applies live to the running row and preview; only *Save changes* persists through `ctx.configForms`. *Discard changes* (or leaving the page) reverts an unsaved draft.
- **Native whale preview**: the default look preview reads the official APNG whale mask out of DSH's own stylesheets instead of shipping a copy.
- **Bilingual UI**: complete `zh` / `en` dictionaries; shipped preset names, icon labels and the default line for a new text group follow the DSH locale.
- Read-only `GET /status-flair/health` route, including a browser-client heartbeat for installation diagnostics.

### Changed

- Package renamed from `@local/dsh-status-flair` to `dsh-status-flair`; the client half keeps a short transition shim for hosts that still hold the old client graph row until restart.
- Config split into `presets` and `textPresets`; legacy `presets[].texts` is migrated on first read.
- The shipped configuration now contains the three look presets only, with no text groups.
- The golden preset is renamed from 暖金色思考 to 暖金色 (migrated by name).
- Built-in preset rows keep editable-looking buttons but show them disabled, so the ★ and badges stay aligned.

### Fixed

- The save button was white-on-white: the primary button now uses DSH's own `--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-foreground` pair.
- The ★ marker drifted from the preview: it now marks the row the preview actually sampled and re-samples when the selection changes.
- The "saved" notice moved the page: the status line now has a fixed slot.
- Custom icons using `fill="currentColor"` were invisible as data-URI masks in Chromium; the mask builder now substitutes a solid colour.

## [0.1.0] — not released

- Initial feature set: named looks with copy candidate lines, CSS overrides on `[data-chat-running]`, a `LocaleRuntime#translate` wrapper for `chat.deepDiving` / `chat.deepDivingFor`, fixed/random preset candidate selection, and first/random/rotate copy selection.
