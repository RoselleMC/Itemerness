import {
    contentHash,
    diagnosticSchema,
    previewArtifactSchema,
    projectDocumentSchema,
    type Diagnostic,
    type PreviewRequest,
    type ProjectDocument,
} from "@itemerness/protocol";

/** Thin control-plane client. Every mutation carries the snapshot hash it was derived from. */

export interface AgentStatus {
    readonly connected: boolean;
    readonly mode: "mock" | "agent" | "offline";
    readonly serverId: string | null;
    readonly state: string;
}

export class ControlPlaneHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
        message: string,
    ) {
        super(message);
        this.name = "ControlPlaneHttpError";
    }
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await fetch(input, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...(init?.headers ?? {}),
        },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ControlPlaneHttpError(
            response.status,
            body,
            `${input}: HTTP ${response.status}`,
        );
    }
    return body as T;
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

function parseSaveDocumentResult(body: unknown): SaveDocumentResult {
    if (typeof body !== "object" || body === null)
        throw new Error("control plane returned an invalid save response");
    const record = body as Record<string, unknown>;
    if (
        typeof record.snapshotHash !== "string" ||
        typeof record.revision !== "number" ||
        !Number.isInteger(record.revision)
    ) {
        throw new Error("control plane returned incomplete save metadata");
    }
    return {
        snapshotHash: record.snapshotHash,
        revision: record.revision,
        diagnostics: diagnosticSchema.array().parse(record.diagnostics),
    };
}

function parseDocumentEnvelope(body: unknown): DocumentEnvelope {
    if (typeof body !== "object" || body === null)
        throw new Error("control plane returned an invalid document envelope");
    const record = body as Record<string, unknown>;
    const document = projectDocumentSchema.parse(record.document);
    if (
        typeof record.snapshotHash !== "string" ||
        typeof record.revision !== "number" ||
        !Number.isInteger(record.revision)
    ) {
        throw new Error("control plane returned incomplete document metadata");
    }
    if (contentHash(document) !== record.snapshotHash) {
        throw new Error(
            "control plane document hash does not match its payload",
        );
    }
    return {
        document,
        snapshotHash: record.snapshotHash,
        revision: record.revision,
    };
}

export const controlPlane = {
    async loadDocument(): Promise<DocumentEnvelope> {
        return parseDocumentEnvelope(await json("/api/v1/document"));
    },
    async saveDocument(
        document: ProjectDocument,
        expectedHash: string,
    ): Promise<SaveDocumentResult> {
        return parseSaveDocumentResult(
            await json("/api/v1/document", {
                method: "PUT",
                body: JSON.stringify({ document, expectedHash }),
            }),
        );
    },
    async preview(request: PreviewRequest, signal?: AbortSignal) {
        const body = await json<{ artifact?: unknown; stale?: unknown }>(
            "/api/v1/preview",
            {
                method: "POST",
                body: JSON.stringify(request),
                signal,
            },
        );
        return {
            artifact: previewArtifactSchema.parse(body.artifact),
            stale: body.stale === true,
        };
    },
    agentStatus: () => json<AgentStatus>("/api/v1/agent/status"),
};
