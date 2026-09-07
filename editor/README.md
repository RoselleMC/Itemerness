# Itemerness Editor

A standalone Tauri desktop editor for macOS and Windows. The editor connects to the Itemerness
plugin's API; the plugin never connects back to the editor. There is no separate editor service,
Node sidecar, database, or Docker deployment.

## Development

Requires Node 22+, pnpm 10, Rust 1.97+, and the native [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm dev                 # shared React UI at http://127.0.0.1:5173
pnpm desktop:dev         # native Tauri window; stop a standalone Vite instance first
pnpm typecheck
pnpm test
pnpm e2e                 # starts Vite when needed
pnpm build               # static frontend only
pnpm desktop:build       # portable .app.zip (macOS) or single .exe (Windows)
cargo test --manifest-path apps/web/src-tauri/Cargo.toml
```

Portable artifacts remain in `apps/web/src-tauri/target/release/portable`:

- macOS: `Itemerness-Editor_<version>_macos_<arch>.app.zip`. Extract and run the `.app`; no installer
  or DMG is required. The ZIP preserves executable permissions and bundle metadata.
- Windows: `Itemerness-Editor_<version>_windows_<arch>.exe`. This is the application, not a setup
  program. Frontend assets, the WebView2 loader, and the C runtime are linked into the executable;
  the system must still have [WebView2 Runtime](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options).

No admin rights, services, or installation-directory writes are required. Local drafts and address
history still use the OS per-user WebView storage, not files beside the executable; portable here
means installation-free, not a roaming profile. Signing, notarization, and automatic updates are
not configured. macOS bundles use local ad-hoc integrity signing, not a Developer ID or
notarization; system trust prompts are still possible.

The desktop workflow uploads these artifacts separately from any release. `--target` accepts
`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, and
`aarch64-pc-windows-msvc`; explicit targets use `target/<triple>/release/portable`. Native Windows
builds need MSVC. Cross builds can use `--runner` with a separately installed toolchain, but do not
prove Windows runtime behavior.

## Window Chrome

The integrated header follows AudioHub's platform split: macOS uses an overlay titlebar with
native traffic lights and hidden system title text. A native unified toolbar lets AppKit choose
the larger document-window corners and lower traffic lights (including macOS 26), without private
corner-radius APIs or manual button positioning. The shared header is 52px high. Windows uses an undecorated window with
in-app minimize, maximize/restore, and close controls. Header dragging and double-click zoom use
Tauri's window API, not CSS app-region behavior. Controls are excluded from drag hit testing.
Dialogs leave this strip accessible. Close actually closes this editor; it does not hide a daemon.
Windows Snap Layout hover and a custom native system menu are not implemented.

The center of the titlebar is the plugin connection control, not a search field. It shows the
selected server and live connection state. Open it to enter an API address and token, cancel an
attempt, disconnect, inspect platform/plugin/protocol versions and preview capability, or resolve
a draft conflict. Escape returns focus to the control; clicking elsewhere dismisses the popup.
Closing the popup does not disconnect or cancel an attempt. Unsubmitted tokens are discarded.

The titlebar preferences occupy the free edge opposite system window controls, following AudioHub:
on macOS/browser, appearance, interface language, then save status at the far right; on Windows,
save status at the far left, followed by language and appearance. Windows caption controls remain
at the far right. Menus and keyboard order follow the mirrored placement. Interface language uses
a globe icon, distinct from the translation glyph used for content translations.
Language and Light/Dark/System choices use application-styled keyboard-accessible menus, not native
selects. System is the default appearance and tracks system changes; explicit overrides are remembered
locally. Native window appearance follows the selected mode. Minecraft resource-pack pixels are not
recolored by interface appearance. The save indicator reflects actual synchronization state, provides
recovery actions for errors/conflicts, and respects reduced-motion preferences.

The leftmost primary navigation switches between items, themes, layouts, and data. Its bottom section
contains resource packs (with a mounted-pack count), translations, and settings, followed by the
bottom-most expand/collapse button. Expansion switches between icons with tooltips and icons with
labels, independently of the secondary library; there is no edge-drag separator. The preference is
remembered locally. Resource packs, translations, and settings replace the entire area to the right
of primary navigation with a full page. Settings contains the editor's auto-save preference. These three peer pages have
no back buttons; switch through primary navigation without losing the editor's current selections,
searches, or preview state. Contextual diagnostics keeps a return control. Diagnostics
is available from the preview's problems control. Preview locale, zoom, and persona controls remain
next to the canvas. Interface preferences and editor settings are usable without a plugin connection;
document tools remain locked until the current plugin supplies a valid document.

## Connect To A Plugin

Enable the plugin API. An empty token permits a direct connection without authentication:

```yaml
editor:
    enabled: true
    bind-host: "0.0.0.0"
    port: 18087
    token: ""
    allowed-origins: []
```

Anyone who can reach an empty-token listener can read and edit its drafts. Restrict access to
trusted networks. For authentication, set a random 32-256-character token (for
example, `openssl rand -hex 32`), or use `token: "${ITEMERNESS_EDITOR_TOKEN}"`. An unset environment
reference remains a configuration error, never a silent fallback to unauthenticated mode.

Restart the server, then open the titlebar connection control and enter `http://<server-ip>:18087`
or its HTTPS base address. `0.0.0.0` is the bind address, not the address clients should enter.
Direct remote HTTP is supported by both the native and browser clients; no loopback relay is required.
Leave the editor's token empty only when the plugin is configured without one; a protected plugin
still returns 401. Connection details show whether token authentication is enabled. The native app uses
a restricted Rust HTTP transport; it does not need CORS permissions. Browser development requires
`allowed-origins: ["http://127.0.0.1:5173"]` on the plugin. Allowed origins must be exact, without paths
or wildcards. Address history and recovery drafts are local; tokens are session-only.

The API defaults to disabled with an all-IPv4-interface binding. Existing configurations keep their
explicit bind address; change old `127.0.0.1` bindings to `0.0.0.0` (or a specific network interface)
and allow the API port through the host firewall for direct access. All listener and token changes
require a restart. HTTP shows a non-blocking encryption warning. For untrusted networks, use HTTPS
through a TLS reverse proxy with connection, header/body timeout, and body-size limits.
The editor still rejects embedded URL credentials, query parameters, fragments, and redirects.

Old empty `editor.url`/`editor.token` settings remain disabled for migration. Configured outbound
pairings fail with a migration message. Replace the old settings and credentials; the retired
control plane's in-memory documents are not automatically imported.

## Protocol And Drafts

`GET /api/handshake` follows the plugin's configured authentication mode and reports protocol ranges, schema versions,
capabilities, plugin/Minecraft versions, and compiler identity. The editor selects a common major
and minor; every later request sends `X-Itemerness-Protocol: 2.0`. Unsupported protocols receive 426.
API protocol 2.0, authoring schema 1, and preview schema 1 are independent of application releases.
The retired outbound agent protocol v1 is not supported.
The additive `authentication` field is `none` or `bearer`; older API 2.0 plugins that omit it are
treated as `bearer`. Empty-token clients omit the Authorization header entirely. Origin, TLS,
protocol, size-limit, and compare-and-swap rules apply in both modes.

- `GET /api/v2/document`: current plugin draft, hash, and revision; 404 when no draft exists.
- `PUT /api/v2/document`: `{document, expectedHash}` with compare-and-swap. Use an empty expected
  hash only for first creation. A conflict returns 409 and `actualHash` without overwriting anything.
- `POST /api/v2/preview`: compile the exact embedded document and viewer context, independently of
  autosave. There is no command, script, publication, or arbitrary Bukkit RPC endpoint.

The plugin persists the authoring draft atomically in `plugins/Itemerness/editor/draft.json`.
This is **not** a published artifact: the running catalog remains owned by local YAML. The editor
starts empty, with the editing area disabled and grey. A successful handshake alone does not unlock
it: the current plugin connection must return a valid document. No example configuration is loaded
locally or automatically uploaded to an empty plugin. If the API has no authoring document, the
workspace stays empty; the existing API does not automatically import the plugin's local YAML.

Disconnecting, switching servers, or losing the remote document clears the visible document,
selections, resource packs, and editing tools. Reconnecting always loads from the plugin first.
Conflicts between edits in an active session still require explicit resolution. Legacy local
drafts are not read or deleted. Best-effort recovery copies are scoped to the source API address,
but are never automatically displayed or uploaded; a recovery UI is not implemented.
Polling rechecks capabilities after plugin updates. An already accepted write may still finish at
its original plugin after disconnect, but cannot be retargeted or update the new connection's UI.

## Preview And Assets

### Saving

Auto save is enabled by default and can be disabled in Settings. This preference stays on the local
device, outside plugin documents and undo history. Cmd/Ctrl+S always requests an immediate save of
the current committed draft; macOS also provides File > Save with the native shortcut and a label
matching the interface language. An unconnected or incompatible workspace cannot save. In-place
text is committed before saving. The amber unsaved status light and the connection panel also offer
manual saving; a clean save is a no-op, not another revision.

Manual requests remain serialized with automatic saves and keep compare-and-swap protection. Edits
made after an explicit save snapshot remain unsaved when auto save is off; repeated shortcuts do not
overlap PUTs, and conflicts cannot be forced through. Re-enabling auto save queues the dirty draft.
Drag transactions still never persist intermediate positions. Browser navigation warns about unsaved
changes, and native close/quit offers Save, Don't save, or Cancel. Manual-mode disconnects use the
same confirmation; failed or conflicted saves keep the workspace open. Connection loss still obeys
the empty-workspace contract and recovery remains best effort, not an automatic restore feature.

### Controls And Context Menus

Global item and content inspectors share top-right duplicate and delete icons with application
tooltips. Item deletion uses an application confirmation dialog and remains undoable. Duplicated
items receive fresh recursive block identities and independent localized message keys.

Inspector choices use shared application-styled, keyboard-accessible popups, including grouped
options and unknown-value preservation. Material suggestions, color editing, tooltips and deletion
confirmation also stay inside the application theme. OS file pickers and the native macOS menu bar
remain intentionally native.

Right-click menus target the clicked item, canvas row, library entry, resource pack, translation
cell or diagnostic. Canvas menus share the same insertion, sibling movement and history commands
as direct controls. Library menus expose references instead of unsafe deletion of shared schemas.
Navigation, titlebar, canvas whitespace and text inputs provide their relevant commands too.
Menus support keyboard navigation, Shift+F10, Escape and viewport collision handling without
blocking Windows caption buttons. Text menus read the clipboard only after an explicit Paste;
password copy/cut is disabled and delayed results cannot modify another item or connection.

### Canvas Editing

The canvas owns content selection and insertion. With no selected content, the inspector shows
global item settings only. Selecting a content row replaces the entire inspector with that row's
settings; selecting the item name keeps the global inspector. Clicking canvas whitespace outside
the tooltip or pressing Escape clears selection without changing the document or zoom.

Selected content exposes insert-above and insert-below icons at its left edges. The name exposes
only insert-below, which inserts at the start of the root Lore list. Wrapped/repeated output shares
one pair of controls per logical block; nested insertions stay in the same conditional branch.
The canvas outline provides access to hidden content. Unattributed server-only lines are not guessed
by index or made editable. In-place text editing still supports Enter to commit and Escape to cancel.

Move-up/down controls now live beside the canvas insertion controls, not in the inspector. Dragging
a content row across a sibling's midpoint reorders the actual local preview immediately. Wrapped
rows and selected conditional parents move as logical blocks within their existing branch. A drag
ghost tracks the pointer and edge scrolling exposes offscreen siblings. Reorder and canvas-anchor
gestures form single undo transactions: intermediate states are neither saved nor sent for server
validation; release commits and Escape, pointer cancellation, or focus loss rolls back.

Document-wide undo/redo covers names, content, themes, layouts, data and translations, including
already autosaved edits through the normal CAS queue. History is session-only, capped at 100 steps
with a conservative 32MiB stack budget, and cleared on disconnect or remote document replacement.
Consecutive input in one field coalesces within an 800ms burst. New edits discard the redo branch.
Toolbar arrows and Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, or Ctrl+Y operate on this history. Outside text
inputs, Delete/Backspace removes selected content, Cmd/Ctrl+D duplicates it with independent message
keys, and Alt+Up/Down reorders it. Connection/search fields keep their own text-editing behavior.
View preferences, selection, resource mounting and navigation are not document edits.

The upper-left canvas tools provide percentage zoom, 100% reset, and fit-all. Zoom animates between
the requested and displayed scales, respects reduced motion, and keeps the wheel cursor anchored.
Automatic fitting after content changes remains immediate. Fit mode follows available space and
includes both language previews and edge controls. Blank-space drag pans at any scale; hand mode,
middle-button drag and Space-drag remain available. Fit-all also recenters the canvas. The lighter
neutral-green dark-mode checkerboard separates the UI from dark tooltip pixels without recoloring
the tooltip. These are editor view controls, not changes to Minecraft GUI
scale or the authoring document. Preview language, comparison, geometry, player context, accuracy,
and issues belong to the global inspector. Per-item colored status icons in the secondary list
replace the old canvas verification badge and track the current document/viewer/compiler context.
The checkerboard is anchored to the primary tooltip's canvas origin, with cells sized in logical
canvas units: it moves, zooms and scrolls with the preview instead of staying fixed in the viewport.

The existing item, theme, layout, data, translation, resource-pack, and diagnostic workflows share
one renderer in Tauri and the browser. Only matching production-compiler results may claim server
verification. Local previews remain drafts; browser pixel output never proves real-client fidelity.

Item navigation and discrete theme/layout selection request compilation immediately, without the 250ms typing debounce. Exact successful
results are cached in memory per connection/compiler identity, document hash, item, and viewer context.
The editor warms up to 16 items in the background, runs at most two preview requests concurrently
(only one background request, reserving foreground capacity), and keeps a 32-entry LRU. Repeated selection reuses the complete validated
artifact synchronously. Document/viewer/compiler changes cannot reuse a mismatched result; disconnect
clears the session cache. An uncached first compilation still uses the local draft until the plugin
responds. The local path now includes character and segmented frame layout, flow alignment, padding,
wrapping and width anchors, so a cold edit does not wait for validation to acquire its frame. Local
output remains a draft; server results remain authoritative. Warming is bounded, not an assertion
that every item in a large catalog is always precompiled.

The paint pipeline reuses font providers by immutable source bytes, decoded sprites by pack stack,
and layout/draw lists independently of zoom and annotation controls. Same-sized different glyph
textures cannot share tinted pixels. Tests block every server preview response while checking cold
theme, color, locale, fact, layout, zoom and annotation changes at the next animation frame.

The 26.1.2 tooltip geometry includes both 3px body padding and a separate 9px outer sprite margin on
each edge. Text, line hitboxes, annotations, and canvas anchors share the same content origin. The
renderer's full canvas extent is not the logical text width. Character-frame themes can decorate only
managed Lore, leaving the name above that inner ornament but still inside the vanilla tooltip body.

Bundled 26.1.2 font metrics require no network download. In an unlocked workspace, mount resource-pack ZIPs or `client.jar` locally, or fetch
the pinned Mojang assets directly from the editor. Downloads are SHA-1 verified; Mojang bytes are
not distributed with the application. Browser downloads depend on CDN CORS; local mounting remains
available. The native downloader accepts only the exact bundled manifest URLs.

```sh
pnpm assets:vanilla       # optional local fixture for metrics and Playwright tests
```

Exact preview is currently limited to Minecraft 26.1.2. Other supported plugin versions expose
draft capabilities but do not advertise or execute `preview.compile`. Flat item sprites are
supported; block models and unmeasured TTF providers remain explicitly unsupported.

## Structure

- `apps/web`: React workspace and `src-tauri` desktop host.
- `packages/protocol`: authoring/preview schemas, handshake negotiation, canonical hashes.
- `packages/mc-assets`, `packages/mc-render`: resource readers, fonts, geometry, canvas rendering.
- JVM `itemerness-editor-agent`: the existing module name now contains the **inbound** API,
  persistent draft store, and production compiler bridge. No outbound agent remains.

Future publish/rollback, review, per-user permissions, multi-document collaboration, and multi-server
coordination must remain plugin-led. The desktop application must not acquire a mandatory remote
editor backend again.
