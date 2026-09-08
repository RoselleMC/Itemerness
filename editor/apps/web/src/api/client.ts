import {
    catalogReadSchema,
    catalogExportSchema,
    contentHash,
    diagnosticSchema,
    handshakeSchema,
    negotiateProtocol,
    previewArtifactSchema,
    projectDocumentSchema,
    supportsSegmentedFrameDecorations,
    usesSegmentedFrameDecorations,
    supportsExtendedBaseComponents,
    usesExtendedBaseComponents,
    type Diagnostic,
    type Handshake,
    type PreviewRequest,
    type ProjectDocument,
} from "@itemerness/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";

export class PluginHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
        message: string,
    ) {
        super(message);
        this.name = "PluginHttpError";
    }
}

export interface DocumentEnvelope {
    readonly document: ProjectDocument;
    readonly snapshotHash: string;
    readonly revision: number;
}

export interface SaveDocumentResult {
    readonly snapshotHash: string;
    readonly revision: number;
    readonly diagnostics: Diagnostic[];
}

export function normalizeApiUrl(value: string): string {
    const url = new URL(value.trim());
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /%|\\/.test(value) ||
        /\/\.{1,2}(?:\/|$)/.test(value)
    ) {
        throw new Error("INVALID_API_URL");
    }
    return url.href.replace(/\/+$/, "");
}

async function responseJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("INVALID_API_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 2 * 1024 * 1024) throw new Error("RESPONSE_TOO_LARGE");
            chunks.push(chunk.value);
        }
    } finally {
        await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function record(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object")
        throw new Error("INVALID_API_RESPONSE");
    return body as Record<string, unknown>;
}

function metadata(body: unknown) {
    const value = record(body);
    if (
        typeof value.snapshotHash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(value.snapshotHash) ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1
    ) {
        throw new Error("INVALID_API_RESPONSE");
    }
    return { snapshotHash: value.snapshotHash, revision: value.revision };
}

function requestDeadline(signals: readonly AbortSignal[]) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of signals) {
        if (signal.aborted) abort();
        signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(abort, 15_000);
    return {
        signal: controller.signal,
        check() {
            if (controller.signal.aborted)
                throw new DOMException("Request cancelled", "AbortError");
        },
        dispose() {
            clearTimeout(timer);
            for (const signal of signals)
                signal.removeEventListener("abort", abort);
        },
    };
}

/** A client is bound to one endpoint and credential; switching creates a new instance. */
export class PluginClient {
    readonly baseUrl: string;
    private readonly abort = new AbortController();
    private protocol: string | null = null;
    private documentSchemas: readonly number[] = [];
    private capabilities: readonly string[] = [];
    private serverId: string | null = null;
    private identityChanged = false;
    private writesSuspended = false;

    constructor(
        baseUrl: string,
        private readonly token: string,
    ) {
        this.baseUrl = normalizeApiUrl(baseUrl);
        if (token !== "" && !/^[A-Za-z0-9_~+/.=-]{32,256}$/.test(token))
            throw new Error("INVALID_TOKEN");
    }

    close(): void {
        this.abort.abort();
    }

    suspendWrites(suspended: boolean): void {
        this.writesSuspended = suspended;
    }

    async handshake(): Promise<{ info: Handshake; protocol: string }> {
        const info = handshakeSchema.parse(await this.json("/api/handshake"));
        const protocol = negotiateProtocol(info);
        if (this.serverId !== null && this.serverId !== info.serverId) {
            this.identityChanged = true;
            throw new Error("SERVER_IDENTITY_CHANGED");
        }
        this.serverId = info.serverId;
        this.protocol = protocol;
        this.documentSchemas = [...info.documentSchemas];
        this.capabilities = [...info.capabilities];
        return { info, protocol };
    }

    async loadDocument(): Promise<DocumentEnvelope | null> {
        let body: unknown;
        try {
            body = await this.json("/api/v2/document");
        } catch (error) {
            if (
                error instanceof PluginHttpError &&
                error.status === 404 &&
                record(error.body).code === "DRAFT_NOT_FOUND"
            )
                return null;
            throw error;
        }
        const document = projectDocumentSchema.parse(record(body).document);
        this.assertResponseIdentity(body);
        this.assertDocumentSupported(document);
        const meta = metadata(body);
        if (contentHash(document) !== meta.snapshotHash)
            throw new Error("SNAPSHOT_MISMATCH");
        return { document, ...meta };
    }

    async saveDocument(
        document: ProjectDocument,
        expectedHash: string,
    ): Promise<SaveDocumentResult> {
        this.assertDocumentSendable(document);
        const body = await this.json("/api/v2/document", "PUT", {
            document,
            expectedHash,
            ...(this.capabilities.includes("server.identity.persistent")
                ? { targetServerId: this.serverId }
                : {}),
        });
        this.assertResponseIdentity(body);
        return {
            ...metadata(body),
            diagnostics: diagnosticSchema
                .array()
                .parse(record(body).diagnostics),
        };
    }

    async saveServerAlias(alias: string, expectedAlias: string) {
        if (!this.capabilities.includes("server.alias.write"))
            throw new Error("SERVER_ALIAS_UNSUPPORTED");
        const body = record(
            await this.json("/api/v2/server", "PUT", {
                alias,
                expectedAlias,
                targetServerId: this.serverId,
            }),
        );
        this.assertResponseIdentity(body);
        if (typeof body.serverAlias !== "string" || body.serverAlias !== alias)
            throw new Error("SERVER_ALIAS_RESPONSE_INVALID");
        return body.serverAlias;
    }

    async readCatalog(signal?: AbortSignal) {
        const result = catalogReadSchema.parse(
            await this.json("/api/v2/catalog", "GET", undefined, signal),
        );
        this.assertDocumentSupported(result.document);
        return result;
    }

    async exportCatalog(
        document: ProjectDocument,
        targetServerId: string,
        signal?: AbortSignal,
    ) {
        this.assertDocumentSendable(document);
        return catalogExportSchema.parse(
            await this.json(
                "/api/v2/catalog/export",
                "POST",
                {
                    document,
                    snapshotHash: contentHash(document),
                    targetServerId,
                },
                signal,
            ),
        );
    }

    async preview(request: PreviewRequest, signal?: AbortSignal) {
        this.assertDocumentSendable(request.document);
        const body = record(
            await this.json("/api/v2/preview", "POST", request, signal),
        );
        const artifact = previewArtifactSchema.parse(body.artifact);
        if (
            artifact.origin !== "agent" ||
            artifact.itemId !== request.itemId ||
            contentHash(artifact.viewer) !== contentHash(request.viewer)
        )
            throw new Error("INVALID_PREVIEW_RESPONSE");
        return {
            artifact,
            stale:
                body.stale === true ||
                artifact.digests.snapshot !== request.snapshotHash,
        };
    }

    private assertResponseIdentity(body: unknown): void {
        if (
            this.capabilities.includes("server.identity.persistent") &&
            record(body).serverId !== this.serverId
        ) {
            this.identityChanged = true;
            throw new Error("SERVER_IDENTITY_CHANGED");
        }
    }

    private assertDocumentSupported(document: ProjectDocument): void {
        if (!this.protocol) throw new Error("HANDSHAKE_REQUIRED");
        // Validate without normalizing the submitted snapshot or changing its CAS identity.
        projectDocumentSchema.parse(document);
        if (!this.documentSchemas.includes(document.schemaVersion))
            throw new Error("DOCUMENT_SCHEMA_INCOMPATIBLE");
    }

    private assertDocumentSendable(document: ProjectDocument): void {
        this.assertDocumentSupported(document);
        if (
            usesExtendedBaseComponents(document) &&
            !supportsExtendedBaseComponents(this.capabilities)
        )
            throw new Error("EXTENDED_BASE_COMPONENTS_UNSUPPORTED");
        if (
            usesSegmentedFrameDecorations(document) &&
            !supportsSegmentedFrameDecorations(this.capabilities)
        )
            throw new Error("SEGMENTED_FRAME_DECORATIONS_UNSUPPORTED");
    }

    private async json(
        path: string,
        method = "GET",
        body?: unknown,
        signal?: AbortSignal,
    ): Promise<unknown> {
        if (this.identityChanged) throw new Error("SERVER_IDENTITY_CHANGED");
        if (this.writesSuspended && method !== "GET")
            throw new Error("CONNECTION_INTERRUPTED");
        if (path !== "/api/handshake" && !this.protocol)
            throw new Error("HANDSHAKE_REQUIRED");
        // Avoid AbortSignal.any/timeout: older supported WKWebView releases lack them.
        const deadline = requestDeadline([
            this.abort.signal,
            ...(signal ? [signal] : []),
        ]);
        try {
            deadline.check();
            const encoded =
                body === undefined ? undefined : JSON.stringify(body);
            if (
                encoded &&
                new TextEncoder().encode(encoded).length > 2 * 1024 * 1024
            )
                throw new Error("REQUEST_TOO_LARGE");
            let status: number;
            let decoded: unknown;
            if (isTauri()) {
                const response = await invoke<{ status: number; body: string }>(
                    "plugin_request",
                    {
                        baseUrl: this.baseUrl,
                        token: this.token,
                        path,
                        method,
                        body: encoded ?? null,
                        protocol: this.protocol,
                    },
                );
                status = response.status;
                decoded = JSON.parse(response.body);
            } else {
                const response = await fetch(this.baseUrl + path, {
                    method,
                    body: encoded,
                    signal: deadline.signal,
                    redirect: "error",
                    credentials: "omit",
                    headers: {
                        ...(this.token
                            ? { Authorization: `Bearer ${this.token}` }
                            : {}),
                        ...(encoded
                            ? { "Content-Type": "application/json" }
                            : {}),
                        ...(this.protocol
                            ? { "X-Itemerness-Protocol": this.protocol }
                            : {}),
                    },
                });
                status = response.status;
                decoded = await responseJson(response);
            }
            deadline.check();
            if (this.identityChanged)
                throw new Error("SERVER_IDENTITY_CHANGED");
            if (
                path === "/api/v2/document" &&
                (status === 200 || status === 404)
            )
                this.assertResponseIdentity(decoded);
            if (status < 200 || status >= 300) {
                if (record(decoded).code === "TARGET_MISMATCH") {
                    this.identityChanged = true;
                    throw new Error("SERVER_IDENTITY_CHANGED");
                }
                const code =
                    status === 401 && !this.token
                        ? "TOKEN_REQUIRED"
                        : typeof record(decoded).code === "string"
                          ? String(record(decoded).code)
                          : `HTTP_${status}`;
                throw new PluginHttpError(status, decoded, code);
            }
            return decoded;
        } finally {
            deadline.dispose();
        }
    }
}
