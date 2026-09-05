import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
    contentHash,
    previewRequestSchema,
    projectDocumentSchema,
    runoRpgCatalogItemCreateSchema,
    runoRpgCatalogItemUpdateSchema,
    type Diagnostic,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { AgentRegistry } from "./agent-channel.js";
import { AgentTokenStore } from "./agent-token-store.js";
import { compilePreviewRequest } from "./preview-service.js";
import {
    VanillaAssetError,
    VanillaAssetService,
    defaultVanillaOptions,
} from "./vanilla-assets.js";
import {
    createRequestBoundary,
    rejectBoundaryRequest,
    type OriginPolicy,
} from "./request-security.js";
import {
    RunoRpgCatalogError,
    RunoRpgCatalogService,
} from "./runorpg-catalog.js";
import { ServerResourcePackService } from "./server-resource-pack.js";
import {
    packIdFromSha1,
    withServerResourcePackBinding,
} from "./resource-pack-binding.js";

/**
 * The control plane.
 *
 * One origin serves the browser UI, a versioned JSON API, the browser WebSocket, and the agent
 * WebSocket, which is what lets a downstream server be configured with only a URL and a token.
 *
 * Preview requests go to a connected target when there is one and fall back to an in-process mock
 * otherwise. The two are labelled differently and never conflated: `agent` means a Minecraft server
 * ran the production compiler, `mock` means this process replayed the browser's composer. Erasing
 * that difference for convenience would make the whole fidelity ladder meaningless.
 *
 * Draft state is in memory and there is no human authentication yet. Both are why the shipped
 * deployment binds to loopback; persistence and RBAC are the next phase.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(
    process.env.ITEMERNESS_REPO_ROOT ?? join(here, "../../../.."),
);
const webRoot = resolve(
    process.env.ITEMERNESS_WEB_ROOT ?? join(here, "../../web/dist"),
);
const clientVersion = process.env.ITEMERNESS_CLIENT_VERSION ?? "1.21.11";
const artifactPath = join(
    repositoryRoot,
    `itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-${clientVersion}.ifm`,
);
const port = Number(process.env.PORT ?? 8080);
const requestBoundary = createRequestBoundary(
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    port,
);

interface DraftState {
    document: ProjectDocument;
    snapshotHash: string;
    revision: number;
}

const draft: DraftState = {
    document: baselineDocument,
    snapshotHash: contentHash(baselineDocument),
    revision: 1,
};

/**
 * Points the draft at the pack this deployment serves.
 *
 * Without it every `NATIVE_TOOLTIP_STYLE` theme falls back to character art, because the shipped
 * document's binding is an all-zero placeholder that matches nothing. Doing it here rather than
 * committing the values keeps a deployment-specific SHA-1 out of the fixture, and means the frames
 * are correct on the very first page load instead of after someone remembers to run a script.
 *
 * Run at boot and again whenever the browser asks what pack is served — which is the request it
 * makes immediately before mounting it. `/betterhud reload` rewrites the pack and changes its
 * SHA-1, and a binding pinned at boot would quietly stop matching until the next restart.
 */
async function bindServerResourcePack(): Promise<void> {
    const status = await serverResourcePack.status();
    if (!status.available || !status.sha1) return;
    const bound = withServerResourcePackBinding(draft.document, status.sha1);
    if (bound === draft.document) return;
    draft.document = bound;
    draft.snapshotHash = contentHash(bound);
    draft.revision += 1;
    app.log.info(
        { sha1: status.sha1, packId: packIdFromSha1(status.sha1) },
        "bound the authoring document to the served resource pack",
    );
    broadcast({
        type: "draft.updated",
        snapshotHash: draft.snapshotHash,
        revision: draft.revision,
    });
}

const vanilla = new VanillaAssetService(
    defaultVanillaOptions(repositoryRoot, clientVersion),
);
const runoRpgCatalog = new RunoRpgCatalogService({
    catalogRoot: process.env.ITEMERNESS_CATALOG_ROOT ?? null,
    attributesFile: process.env.RUNORPG_ATTRIBUTES_FILE ?? null,
    snapshotFile: process.env.RUNORPG_EDITOR_SNAPSHOT ?? null,
});
const serverResourcePack = new ServerResourcePackService(
    process.env.ITEMERNESS_RESOURCE_PACK ?? null,
);

// The pepper is what stops a stolen token table from being replayed. A generated value means a
// restart invalidates outstanding tokens, which is correct for a dev deployment and wrong for a
// real one; production sets it explicitly and backs it up with the database.
const agentTokenStore = new AgentTokenStore(
    process.env.ITEMERNESS_AGENT_TOKEN_STORE ?? null,
);
const agents = new AgentRegistry(
    process.env.ITEMERNESS_TOKEN_PEPPER ?? randomBytes(32).toString("hex"),
    await agentTokenStore.load(),
);

let cachedArtifact: Buffer | null = null;
async function fontMetricsArtifact(): Promise<Buffer | null> {
    if (cachedArtifact) return cachedArtifact;
    if (!existsSync(artifactPath)) return null;
    cachedArtifact = await readFile(artifactPath);
    return cachedArtifact;
}

const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 8 * 1024 * 1024,
});

await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });

app.addHook("onRequest", async (request, reply) => {
    const websocketUpgrade =
        request.headers.upgrade?.toLowerCase() === "websocket";
    const pathname = request.url.split("?", 1)[0]!;
    const agentSocket = pathname === "/api/v1/agent" && websocketUpgrade;
    let originPolicy: OriginPolicy = "ignore";
    if (pathname === "/api/v1/events" && websocketUpgrade) {
        originPolicy = "required";
    } else if (
        (pathname.startsWith("/api/") || pathname.startsWith("/health/")) &&
        !agentSocket
    ) {
        originPolicy = "if-present";
    }
    const rejection = rejectBoundaryRequest(requestBoundary, {
        host: request.headers.host,
        origin: request.headers.origin,
        originPolicy,
    });
    if (rejection) {
        return reply
            .code(rejection.statusCode)
            .send({ error: rejection.error });
    }
});

if (!process.env.ITEMERNESS_TOKEN_PEPPER) {
    app.log.warn(
        "ITEMERNESS_TOKEN_PEPPER is unset; agent tokens will not survive a restart",
    );
}

app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
        "content-security-policy",
        // No inline script and no third-party origins: a resource pack is untrusted input and the
        // page that parses it should have nowhere to send what it finds.
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
});

app.get("/health/live", async () => ({ status: "live" }));
app.get("/health/ready", async () => ({
    status: "ready",
    draftRevision: draft.revision,
    fontMetricsAvailable: existsSync(artifactPath),
}));

app.get("/api/v1/document", async () => ({
    document: draft.document,
    snapshotHash: draft.snapshotHash,
    revision: draft.revision,
}));

app.put("/api/v1/document", async (request, reply) => {
    const body = request.body as { document?: unknown; expectedHash?: unknown };
    if (typeof body?.expectedHash !== "string") {
        return reply.code(400).send({ error: "expectedHash is required" });
    }
    // Optimistic concurrency rather than last-write-wins: two editors saving the same base must
    // get a conflict they can resolve, not a silent overwrite.
    if (body.expectedHash !== draft.snapshotHash) {
        return reply.code(409).send({
            error: "conflict",
            expectedHash: body.expectedHash,
            actualHash: draft.snapshotHash,
        });
    }
    const parsed = projectDocumentSchema.safeParse(body.document);
    if (!parsed.success) {
        const diagnostics: Diagnostic[] = parsed.error.issues
            .slice(0, 64)
            .map((issue) => ({
                code: "DOCUMENT.SCHEMA",
                severity: "ERROR",
                origin: "control-plane",
                messageKey: "diagnostics.document.schema",
                params: { detail: issue.message },
                pointer: `/${issue.path.join("/")}`,
                nodeUuid: null,
                businessId: null,
                targetServerId: null,
                fixKey: null,
            }));
        return reply.code(422).send({ diagnostics });
    }
    draft.document = parsed.data;
    draft.snapshotHash = contentHash(parsed.data);
    draft.revision += 1;
    broadcast({
        type: "draft.updated",
        snapshotHash: draft.snapshotHash,
        revision: draft.revision,
    });
    return {
        snapshotHash: draft.snapshotHash,
        revision: draft.revision,
        diagnostics: [],
    };
});

app.get("/api/v1/agent/status", async () => {
    const connections = agents.list();
    const primary = connections[0];
    return {
        connected: connections.length > 0,
        // `mock` is not a smaller version of `agent`; it is a different claim about where the
        // answer came from, and the UI badges it differently for exactly that reason.
        mode: primary ? ("agent" as const) : ("mock" as const),
        serverId: primary?.serverId ?? null,
        state: primary ? "ready" : "offline",
        connections: connections.map((connection) => ({
            serverId: connection.serverId,
            generation: connection.generation,
            connectedAt: connection.connectedAt,
            capabilities: connection.capabilities,
        })),
        tokens: agents.listTokens(),
    };
});

app.get("/api/v1/runorpg/catalog", async (_request, reply) => {
    const catalog = await runoRpgCatalog.catalog();
    return reply
        .header("cache-control", "no-store")
        .code(catalog.available ? 200 : 503)
        .send(catalog);
});

app.post("/api/v1/runorpg/catalog/item", async (request, reply) => {
    const parsed = runoRpgCatalogItemCreateSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({
            error: "invalid RunoRPG item create request",
            issues: parsed.error.issues.slice(0, 32),
        });
    }
    try {
        const created = await runoRpgCatalog.create(parsed.data);
        return reply
            .code(201)
            .header("cache-control", "no-store")
            .send({
                created: `runocraft:${created.localId}`,
            });
    } catch (error) {
        if (error instanceof RunoRpgCatalogError) {
            const status =
                error.code === "conflict"
                    ? 409
                    : error.code === "invalid-source"
                      ? 422
                      : error.code === "read-only"
                        ? 403
                        : 503;
            return reply.code(status).send({
                error: error.code,
                detail: error.message,
            });
        }
        request.log.error({ err: error }, "RunoRPG catalog create failed");
        return reply.code(500).send({ error: "catalog create failed" });
    }
});

app.put("/api/v1/runorpg/catalog/item", async (request, reply) => {
    const parsed = runoRpgCatalogItemUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({
            error: "invalid RunoRPG item update",
            issues: parsed.error.issues.slice(0, 32),
        });
    }
    try {
        const saved = await runoRpgCatalog.update(parsed.data);
        return reply.header("cache-control", "no-store").send({
            saved: saved.id,
        });
    } catch (error) {
        if (error instanceof RunoRpgCatalogError) {
            const status =
                error.code === "conflict"
                    ? 409
                    : error.code === "not-found"
                      ? 404
                      : error.code === "invalid-source"
                        ? 422
                        : error.code === "read-only"
                          ? 403
                          : 503;
            return reply.code(status).send({
                error: error.code,
                detail: error.message,
            });
        }
        request.log.error({ err: error }, "RunoRPG catalog update failed");
        return reply.code(500).send({ error: "catalog update failed" });
    }
});

app.get(
    "/api/v1/server-assets/resource-pack/status",
    async (_request, reply) => {
        const status = await serverResourcePack.status();
        await bindServerResourcePack();
        return reply.header("cache-control", "no-store").send(status);
    },
);

app.get("/api/v1/server-assets/resource-pack", async (request, reply) => {
    try {
        const pack = await serverResourcePack.bytes();
        return reply
            .header("content-type", "application/zip")
            .header("cache-control", "no-cache")
            .header("etag", `"${pack.sha1}"`)
            .header("x-itemerness-pack-name", encodeURIComponent(pack.name))
            .send(pack.bytes);
    } catch (error) {
        request.log.warn({ err: error }, "server resource pack unavailable");
        return reply.code(503).send({ error: (error as Error).message });
    }
});

/**
 * Issues an agent token. The plaintext is returned exactly once.
 *
 * This endpoint is unauthenticated in this build, which is why the deployment binds to loopback.
 * Human authentication and RBAC are the next phase; shipping a token endpoint that pretends to be
 * protected would be worse than one that is documented as not being.
 */
app.post("/api/v1/agent/tokens", async (request, reply) => {
    const body = (request.body ?? {}) as {
        serverId?: unknown;
        name?: unknown;
        environment?: unknown;
    };
    const serverId =
        typeof body.serverId === "string" && body.serverId.length > 0
            ? body.serverId
            : null;
    if (!serverId)
        return reply.code(400).send({ error: "serverId is required" });
    const environment =
        body.environment === "staging" || body.environment === "production"
            ? body.environment
            : "development";
    const { token, plaintext } = agents.issueToken({
        serverId,
        name: typeof body.name === "string" ? body.name : serverId,
        environment,
    });
    try {
        await agentTokenStore.save(agents.tokenSnapshot());
    } catch (error) {
        agents.discardToken(token.lookupId);
        throw error;
    }
    request.log.info(
        { lookupId: token.lookupId, serverId },
        "issued an agent token",
    );
    return {
        lookupId: token.lookupId,
        serverId,
        environment,
        token: plaintext,
    };
});

app.delete("/api/v1/agent/tokens/:lookupId", async (request, reply) => {
    const { lookupId } = request.params as { lookupId: string };
    if (!agents.revokeToken(lookupId))
        return reply.code(404).send({ error: "unknown token" });
    await agentTokenStore.save(agents.tokenSnapshot());
    return { revoked: lookupId };
});

app.post("/api/v1/preview", async (request, reply) => {
    const parsed = previewRequestSchema.safeParse(request.body);
    if (!parsed.success)
        return reply.code(400).send({
            error: "invalid preview request",
            issues: parsed.error.issues.slice(0, 16),
        });

    const target = parsed.data.targetServerId
        ? agents.get(parsed.data.targetServerId)
        : agents.list()[0];
    const artifactBytes = await fontMetricsArtifact();
    const result = await compilePreviewRequest(parsed.data, {
        fontMetricsArtifact: artifactBytes
            ? new Uint8Array(artifactBytes)
            : null,
        compileWithAgent: target
            ? (payload) =>
                  agents.request(target.serverId, "preview.compile", payload)
            : undefined,
    });
    if (result.agentError) {
        request.log.warn(
            { err: result.agentError, serverId: target?.serverId },
            "agent preview failed; falling back to mock",
        );
    }
    return { artifact: result.artifact, stale: result.stale };
});

app.get("/api/v1/font-metrics/:version", async (request, reply) => {
    const { version } = request.params as { version: string };
    if (version !== clientVersion)
        return reply.code(404).send({ error: "unknown metrics version" });
    const bytes = await fontMetricsArtifact();
    if (!bytes)
        return reply.code(503).send({
            error: "metrics artifact is not available in this deployment",
        });
    return reply
        .header("content-type", "application/octet-stream")
        .header("cache-control", "public, max-age=86400")
        .send(bytes);
});

app.get("/api/v1/vanilla-assets/:version/manifest", async (request, reply) => {
    try {
        const manifest = await vanilla.manifest();
        const { version } = request.params as { version: string };
        if (version !== manifest.clientVersion)
            return reply.code(404).send({ error: "unknown version" });
        return {
            clientVersion: manifest.clientVersion,
            client: { sha1: manifest.client.sha1 },
            assetIndex: {
                id: manifest.assetIndex.id,
                sha1: manifest.assetIndex.sha1,
            },
            clientResources: Object.keys(manifest.clientResources),
            assetResources: Object.keys(manifest.assetResources),
        };
    } catch (error) {
        return reply.code(503).send({ error: (error as Error).message });
    }
});

app.get("/api/v1/vanilla-assets/:version/bundle", async (request, reply) => {
    const { version } = request.params as { version: string };
    try {
        const bytes = await vanilla.bundle(version);
        return reply
            .header("content-type", "application/zip")
            .header("cache-control", "public, max-age=86400")
            .send(Buffer.from(bytes));
    } catch (error) {
        const status = error instanceof VanillaAssetError ? 503 : 500;
        request.log.error({ err: error }, "vanilla asset bundle failed");
        return reply.code(status).send({ error: (error as Error).message });
    }
});

const sockets = new Set<{ send(data: string): void }>();
function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
        try {
            socket.send(payload);
        } catch {
            sockets.delete(socket);
        }
    }
}

/**
 * The agent channel. Servers connect out to this; it never connects in to them.
 */
app.get("/api/v1/agent", { websocket: true }, (socket, request) => {
    const header = request.headers.authorization;
    const token = agents.authenticate(
        header?.startsWith("Bearer ") ? header.slice(7) : undefined,
    );
    if (!token) {
        request.log.warn(
            { ip: request.ip },
            "rejected an agent connection with an invalid token",
        );
        socket.close(4401, "unauthorized");
        return;
    }
    const connection = agents.register(token.serverId, {
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code ?? 1000, reason),
    });
    request.log.info(
        { serverId: token.serverId, generation: connection.generation },
        "agent connected",
    );

    socket.on("message", (data: Buffer) => {
        const reply = agents.handleMessage(connection, data.toString("utf8"));
        if (reply) socket.send(reply);
    });
    socket.on("close", () => {
        agents.unregister(token.serverId, connection.generation);
        broadcast({ type: "agent.disconnected", serverId: token.serverId });
    });
    broadcast({
        type: "agent.connected",
        serverId: token.serverId,
        generation: connection.generation,
    });
});

app.get("/api/v1/events", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(
        JSON.stringify({
            type: "hello",
            snapshotHash: draft.snapshotHash,
            revision: draft.revision,
        }),
    );
    socket.on("close", () => sockets.delete(socket));
});

if (existsSync(webRoot)) {
    // Same origin for UI, API, and WebSocket, so a deployment only ever needs one public URL.
    // The wildcard route resolves files per request. Globbing the directory at boot instead would
    // 404 every hashed asset produced by a rebuild, which is exactly what a rolling deploy does.
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
        if (
            request.url.startsWith("/api") ||
            request.url.startsWith("/health")
        ) {
            return reply.code(404).send({ error: "not found" });
        }
        return reply.sendFile("index.html");
    });
} else {
    app.log.warn({ webRoot }, "web bundle not found; serving API only");
}

await bindServerResourcePack();

// Development stays loopback-only because this build has no human authentication. The container
// explicitly sets HOST=0.0.0.0 and publishes it through a loopback-bound host port by default.
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
