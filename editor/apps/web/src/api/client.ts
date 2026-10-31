import {
    catalogReadSchema,
    catalogExportSchema,
    catalogStatusSchema,
    contentHash,
    diagnosticSchema,
    handshakeSchema,
    LEGACY_TRANSFER_LIMITS,
    negotiateProtocol,
    negotiateTransferLimits,
    previewArtifactSchema,
    previewProvidersSchema,
    projectDocumentSchema,
    supportsSegmentedFrameDecorations,
    supportsDataFieldConstraints,
    usesDataFieldConstraints,
    supportsDataSchemaOwners,
    usesDataSchemaOwners,
    supportsCatalogSourceLayout,
    usesCatalogSourceLayout,
    supportsThemeSelectors,
    usesThemeSelectors,
    supportsResourcePackDelivery,
    usesResourcePackDelivery,
    supportsShownFlags,
    usesShownFlags,
    supportsComposition,
    supportsGroups,
    supportsHiding,
    usesComposition,
    usesGroups,
    usesHiding,
    usesSegmentedFrameDecorations,
    supportsExtendedBaseComponents,
    usesExtendedBaseComponents,
    type Diagnostic,
    type Handshake,
    type PreviewRequest,
    type ProjectDocument,
    type TransferLimits,
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

/** A transfer refused for its size, by this editor or by the plugin; sizes are UTF-8 bytes. */
export class TransferSizeError extends Error {
    constructor(
        code: "DOCUMENT_TOO_LARGE" | "REQUEST_TOO_LARGE" | "RESPONSE_TOO_LARGE",
        readonly limitBytes: number,
        /** Unknown when reading stopped at the limit. */
        readonly actualBytes: number | null,
    ) {
        super(code);
        this.name = "TransferSizeError";
    }
}

const SIZE_CODES = new Set([
    "DOCUMENT_TOO_LARGE",
    "REQUEST_TOO_LARGE",
    "RESPONSE_TOO_LARGE",
    "CATALOG_DOCUMENT_TOO_LARGE",
    "CATALOG_RESPONSE_TOO_LARGE",
]);

/** Size details of a refusal from either peer, for messages that say how far over a document is. */
export function transferSizeDetail(
    error: unknown,
): { code: string; limitBytes: number | null; actualBytes: number | null } | null {
    if (error instanceof TransferSizeError)
        return {
            code: error.message,
            limitBytes: error.limitBytes,
            actualBytes: error.actualBytes,
        };
    if (!(error instanceof PluginHttpError) || !SIZE_CODES.has(error.message))
        return null;
    const body =
        error.body && typeof error.body === "object"
            ? (error.body as Record<string, unknown>)
            : {};
    const bytes = (value: unknown) => {
        const number = typeof value === "string" ? Number(value) : value;
        return typeof number === "number" && Number.isSafeInteger(number)
            ? number
            : null;
    };
    // Configuration transfers report sizes in their diagnostic; plugins without transfer.limits report none.
    const params = Array.isArray(body.diagnostics)
        ? (body.diagnostics[0] as { params?: Record<string, unknown> })?.params
        : undefined;
    return {
        code: error.message,
        limitBytes: bytes(body.limitBytes ?? params?.limitBytes),
        actualBytes: bytes(body.actualBytes ?? params?.actualBytes),
    };
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

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

async function responseJson(
    response: Response,
    limit: number,
    progress: () => void = () => {},
): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("INVALID_API_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            progress();
            size += chunk.value.length;
            if (size > limit)
                throw new TransferSizeError("RESPONSE_TOO_LARGE", limit, null);
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

/** Documents above this size are previewed by snapshot reference before uploading them. */
const REFERENCE_THRESHOLD_BYTES = 256 * 1024;

/** Idle time after which a stalled request fails; mirrors the plugin's watchdog. */
const IDLE_MILLIS = 15_000;
const TOTAL_MILLIS = 300_000;
/** A conservative upload rate: the browser cannot report upload progress, so time is budgeted. */
const UPLOAD_BYTES_PER_SECOND = 256 * 1024;

/**
 * Fails a request that stops making progress instead of one that is merely long: the budget covers
 * the upload at a conservative rate, and every received response chunk renews it.
 */
function requestDeadline(signals: readonly AbortSignal[], uploadBytes = 0) {
    const controller = new AbortController();
    const started = Date.now();
    let timedOut = false;
    const abort = () => controller.abort();
    for (const signal of signals) {
        if (signal.aborted) abort();
        signal.addEventListener("abort", abort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (millis: number) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(
            () => {
                timedOut = true;
                abort();
            },
            Math.max(0, Math.min(millis, started + TOTAL_MILLIS - Date.now())),
        );
    };
    arm(IDLE_MILLIS + (uploadBytes / UPLOAD_BYTES_PER_SECOND) * 1000);
    return {
        signal: controller.signal,
        get timedOut() {
            return timedOut;
        },
        progress() {
            arm(IDLE_MILLIS);
        },
        check() {
            if (timedOut) throw new Error("REQUEST_TIMEOUT");
            if (controller.signal.aborted)
                throw new DOMException("Request cancelled", "AbortError");
        },
        dispose() {
            if (timer !== null) clearTimeout(timer);
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
    private limits: TransferLimits = LEGACY_TRANSFER_LIMITS;
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

    /** The limits negotiated in the last handshake; 2 MiB before it and with older plugins. */
    get transferLimits(): TransferLimits {
        return this.limits;
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
        this.limits = negotiateTransferLimits(info);
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
        // Only ask for the additive layout when the plugin can read it back on save and export.
        const layout = supportsCatalogSourceLayout(this.capabilities);
        const result = catalogReadSchema.parse(
            await this.json(
                "/api/v2/catalog",
                "GET",
                undefined,
                signal,
                layout,
            ),
        );
        this.assertDocumentSupported(result.document);
        return result;
    }

    /** A fingerprint only; comparing it with the draft's baseline never reads or replaces the draft. */
    async catalogStatus(signal?: AbortSignal) {
        return catalogStatusSchema.parse(
            await this.json("/api/v2/catalog/status", "GET", undefined, signal),
        );
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
        // Plugins without providers reject the field; a scenario is meaningless to them.
        const { scenario, document, ...base } = request;
        const providers = this.capabilities.includes("preview.providers");
        const fields = scenario && providers ? { ...base, scenario } : base;
        const body = record(
            await this.withSnapshot(
                document,
                request.snapshotHash,
                (included) =>
                    this.json("/api/v2/preview", "POST", { ...fields, ...included }, signal),
            ),
        );
        const artifact = previewArtifactSchema.parse(body.artifact);
        if (
            artifact.origin !== "agent" ||
            artifact.itemId !== request.itemId ||
            contentHash(artifact.viewer) !== contentHash(request.viewer) ||
            (scenario &&
                providers &&
                (artifact.previewData?.plugin !== scenario.plugin ||
                    artifact.previewData.scenario !== scenario.id))
        )
            throw new Error("INVALID_PREVIEW_RESPONSE");
        return {
            artifact,
            stale:
                body.stale === true ||
                artifact.digests.snapshot !== request.snapshotHash,
        };
    }

    /** Scenarios each provider offers for one item of this exact draft. */
    async previewScenarios(
        document: ProjectDocument,
        itemId: string,
        locale: string,
        signal?: AbortSignal,
    ) {
        const snapshotHash = contentHash(document);
        const result = previewProvidersSchema.parse(
            await this.withSnapshot(document, snapshotHash, (included) =>
                this.json(
                    "/api/v2/preview/scenarios",
                    "POST",
                    {
                        ...included,
                        snapshotHash,
                        itemId,
                        locale,
                        targetServerId: this.serverId,
                    },
                    signal,
                ),
            ),
        );
        if (result.itemId !== itemId) throw new Error("INVALID_PREVIEW_RESPONSE");
        return result;
    }

    private readonly documentSizes = new Map<string, number>();

    /**
     * Sends a large document by reference first: the plugin usually still holds the snapshot, as its
     * saved draft or a recent compilation, so the upload is only repeated when it answers
     * `SNAPSHOT_UNKNOWN`. A reference also works for a draft above the current request limit.
     */
    private async withSnapshot(
        document: ProjectDocument,
        snapshotHash: string,
        send: (included: { document?: ProjectDocument }) => Promise<unknown>,
    ): Promise<unknown> {
        let bytes = this.documentSizes.get(snapshotHash);
        if (bytes === undefined) {
            bytes = utf8Length(JSON.stringify(document));
            this.documentSizes.set(snapshotHash, bytes);
            if (this.documentSizes.size > 8)
                this.documentSizes.delete(this.documentSizes.keys().next().value!);
        }
        if (
            bytes > REFERENCE_THRESHOLD_BYTES &&
            this.capabilities.includes("preview.snapshot-reference")
        ) {
            try {
                return await send({});
            } catch (error) {
                if (
                    !(error instanceof PluginHttpError) ||
                    error.message !== "SNAPSHOT_UNKNOWN"
                )
                    throw error;
            }
        }
        this.assertDocumentSendable(document);
        return send({ document });
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
        const bytes = utf8Length(JSON.stringify(document));
        if (bytes > this.limits.documentBytes)
            throw new TransferSizeError(
                "DOCUMENT_TOO_LARGE",
                this.limits.documentBytes,
                bytes,
            );
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
        if (
            usesDataFieldConstraints(document) &&
            !supportsDataFieldConstraints(this.capabilities)
        )
            throw new Error("DATA_FIELD_CONSTRAINTS_UNSUPPORTED");
        if (
            usesDataSchemaOwners(document) &&
            !supportsDataSchemaOwners(this.capabilities)
        )
            throw new Error("DATA_SCHEMA_OWNERS_UNSUPPORTED");
        if (
            usesCatalogSourceLayout(document) &&
            !supportsCatalogSourceLayout(this.capabilities)
        )
            throw new Error("CATALOG_SOURCE_LAYOUT_UNSUPPORTED");
        if (
            usesThemeSelectors(document) &&
            !supportsThemeSelectors(this.capabilities)
        )
            throw new Error("THEME_SELECTORS_UNSUPPORTED");
        if (
            usesResourcePackDelivery(document) &&
            !supportsResourcePackDelivery(this.capabilities)
        )
            throw new Error("RESOURCE_PACK_DELIVERY_UNSUPPORTED");
        if (usesShownFlags(document) && !supportsShownFlags(this.capabilities))
            throw new Error("SHOWN_FLAGS_UNSUPPORTED");
        if (usesGroups(document) && !supportsGroups(this.capabilities))
            throw new Error("GROUPS_UNSUPPORTED");
        if (
            usesComposition(document) &&
            !supportsComposition(this.capabilities)
        )
            throw new Error("COMPOSITION_UNSUPPORTED");
        if (usesHiding(document) && !supportsHiding(this.capabilities))
            throw new Error("HIDING_UNSUPPORTED");
    }

    private async json(
        path: string,
        method = "GET",
        body?: unknown,
        signal?: AbortSignal,
        catalogLayout = false,
    ): Promise<unknown> {
        if (this.identityChanged) throw new Error("SERVER_IDENTITY_CHANGED");
        if (this.writesSuspended && method !== "GET")
            throw new Error("CONNECTION_INTERRUPTED");
        if (path !== "/api/handshake" && !this.protocol)
            throw new Error("HANDSHAKE_REQUIRED");
        // Avoid AbortSignal.any/timeout: older supported WKWebView releases lack them.
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const requestBytes = encoded ? utf8Length(encoded) : 0;
        const deadline = requestDeadline(
            [this.abort.signal, ...(signal ? [signal] : [])],
            requestBytes,
        );
        try {
            deadline.check();
            if (requestBytes > this.limits.requestBytes)
                throw new TransferSizeError(
                    "REQUEST_TOO_LARGE",
                    this.limits.requestBytes,
                    requestBytes,
                );
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
                        layout: catalogLayout,
                    },
                );
                status = response.status;
                // The desktop transport only enforces its fixed ceiling; apply the negotiated limit here.
                const responseBytes = utf8Length(response.body);
                if (responseBytes > this.limits.responseBytes)
                    throw new TransferSizeError(
                        "RESPONSE_TOO_LARGE",
                        this.limits.responseBytes,
                        responseBytes,
                    );
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
                        ...(catalogLayout
                            ? { "X-Itemerness-Catalog-Layout": "1" }
                            : {}),
                    },
                });
                status = response.status;
                deadline.progress();
                decoded = await responseJson(
                    response,
                    this.limits.responseBytes,
                    deadline.progress,
                );
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
        } catch (error) {
            // A deadline abort surfaces as a generic AbortError; say that the request stalled.
            if (deadline.timedOut) throw new Error("REQUEST_TIMEOUT");
            throw error;
        } finally {
            deadline.dispose();
        }
    }
}
