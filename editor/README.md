# Itemerness editor

A self-hostable web editor for Itemerness content, with a preview that reads the same resource-pack
bytes the Minecraft client would.

This is a separate product line developed beside the plugin runtime. The plugin keeps working with
local YAML and never depends on the editor being deployed.

## What is here

| Path                 | Purpose                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`  | Authoring document, preview artifact, diagnostics, and agent envelope as zod schemas, plus RFC 8785 canonicalization and the shared golden fixture                                          |
| `packages/mc-assets` | Resource-pack virtual file system, Minecraft font providers (`bitmap`, `space`, `unihex`, `reference`), GUI sprite metadata, item models, and the reader for the generated metrics artifact |
| `packages/mc-render` | Text measurement, line breaking, tooltip geometry, the canvas painter, fidelity classification, and the optimistic local composer                                                           |
| `apps/web`           | React editor: content tree, item form, locale matrix, asset mounting, and the live preview                                                                                                  |
| `apps/control-plane` | Fastify service: same-origin UI + JSON API, the browser and agent WebSockets, agent tokens, and the verified Mojang asset proxy                                                             |
| `deploy`             | Container image, compose file, and the deploy script                                                                                                                                        |

On the JVM side, `itemerness-editor-protocol` holds the wire contract and the codec that turns an
authoring document into the platform-neutral compiler inputs, and `itemerness-editor-agent` holds
the outbound WebSocket client and compiler bridge. The dependency
direction is `itemerness-bukkit` to `itemerness-editor-agent` to `itemerness-core`, never the
reverse: no Bukkit or NMS type appears in the protocol or the agent.

## Preview fidelity

Every part of a preview is labelled with one of four levels, and the UI shows all of them:

| Level                | Meaning                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `exact-structure`    | Content, references, conditions, locale and theme selection decided by the real Kotlin compiler on a connected target server |
| `metric-faithful`    | Advances, wrapping and anchors computed from real font metrics                                                               |
| `approximate-raster` | Pixels drawn by a browser canvas from the same glyph textures; GPU sampling and rounding may differ                          |
| `client-only`        | GUI scale clamping, screen-edge repositioning, client mods, and vanilla-generated tooltip lines. Never claimed as verified   |

The `metric-faithful` claim is not a promise, it is testable. `packages/mc-assets` derives advances
and ink bounds from raw font providers, and the test suite compares them code point by code point
against `minecraft-26.1.2.ifm`, the artifact `tools/font-metrics/generate_minecraft_font_metrics.py`
generated from the real client jar. The current result is 2,414 code points for `minecraft:default`
and 114,432 for `minecraft:uniform`, with zero mismatches. The same comparison is available in the
app under **Assets → Metrics self-check**.

## Getting Minecraft assets in

Mojang assets are never committed here. Two ways to mount them:

1. **Drag a file in** (default). A `.zip` resource pack or a `client.jar` is parsed in the browser
   with `fflate`; nothing is uploaded.
2. **Fetch through the control plane.** `POST`-free endpoint `/api/v1/vanilla-assets/26.1.2/bundle`
   downloads the files pinned in `tools/font-metrics/26.1.2.sources.json` from the official Mojang
   CDN, verifies every SHA-1 against that manifest, and returns only the font, GUI, and item subset
   the preview needs. Set `ITEMERNESS_ALLOW_ASSET_FETCH=false` for air-gapped installs.

With nothing mounted the preview still has exact advances from the bundled metrics artifact, so
widths, wrapping, and anchors are correct; glyphs are drawn as translucent blocks over their real
ink bounds rather than as substituted shapes, and the fidelity panel says so.

## Development

```sh
pnpm install

# Optional: build the local vanilla asset bundle used by the cross-check tests and E2E suite.
node packages/mc-assets/scripts/fetch-vanilla-assets.mjs

pnpm test                                  # unit and metrics cross-check
pnpm typecheck
pnpm --filter @itemerness/web build        # the control plane serves this build
pnpm dev                                   # control plane on :8080, serving the built UI
pnpm dev:web                               # Vite dev server on :5173, proxying /api to :8080
pnpm --filter @itemerness/web e2e          # Playwright, against http://127.0.0.1:8080
```

Tests that need the vanilla bundle skip loudly when it is absent rather than passing vacuously.

## Deployment

```sh
cp deploy/.env.example deploy/.env    # then fill in the generated secrets
docker compose -f deploy/compose.yaml --env-file deploy/.env up --build
```

`deploy/scripts/deploy.sh <host>` syncs this workspace to a remote host and rebuilds the stack
there. It excludes `deploy/.env` from the sync on purpose: that file holds secrets generated on the
host, and a sync that removed them would turn a routine redeploy into a credential loss.

One image serves the UI, the API, and both WebSocket endpoints from a single origin, which is what
lets a downstream server be configured with only a URL and a token. The build context is the
repository root because the image copies two files from outside `editor/`: the metrics artifact and
the pinned source manifest. Neither contains Mojang assets.

## Pairing a Minecraft server

The plugin dials out; nothing connects in, so no inbound port is needed on the game server.

```sh
curl -X POST http://127.0.0.1:8080/api/v1/agent/tokens \
  -H 'content-type: application/json' \
  -d '{"serverId":"my-server","name":"My server","environment":"development"}'
```

The plaintext token is returned once. Put it, and the control plane's base URL, in the plugin's
`config.yml`:

```yaml
editor:
    url: "https://items.example.com"
    token: "${ITEMERNESS_EDITOR_TOKEN}"
```

Both values empty keeps the catalog local. Setting only one is a configuration error rather than a
silent fallback. A `${NAME}` value is read from the environment. The URL must be HTTPS unless it is
an explicit loopback host, so a token is never sent in clear text. Pairing changes require a server
restart; catalog reload deliberately refuses to rotate a live endpoint without a readiness fence.

Once connected, `/api/v1/preview` is answered by that server running the production compiler, and
the UI badge reads **Server verified**. With no server connected the control plane replays the
browser's own composer and reports `origin: "mock"`, which the UI shows as **Mock agent**. The two
are never conflated.

## Current limits

- **No human authentication.** There is no login, no RBAC, and the token endpoint is unprotected.
  This is why the deployment binds to loopback; put it behind an authenticating proxy, or do not
  expose it. Shipping an auth layer that only looked real would be worse than this.
- **Draft state and agent tokens are in memory.** A control-plane restart invalidates issued tokens
  and resets the draft. The compose file already starts PostgreSQL so persistence does not change
  the topology later.
- Publish, rollback, review policy, and multi-server rollout are not implemented. The agent answers
  `preview.compile`, and nothing else; there is
  deliberately no method that runs a command or invokes arbitrary API.
- Preview never writes deployable artifacts. Managed publish, activation, rollback,
  and last-known-good persistence are not implemented yet.
- Item icons resolve flat sprites only. Block models report `unsupported` and are marked
  `client-only` rather than approximated.
- `ttf` font providers are parsed but not measured. A font using one is reported as having unknown
  metrics instead of being guessed at.
