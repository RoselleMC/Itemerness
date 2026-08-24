import { describe, expect, it, vi } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    previewRequestSchema,
    type PreviewRequest,
    type ProjectDocument,
} from "@itemerness/protocol";
import { compilePreviewRequest } from "../src/preview-service.js";

function editedDocument(name: string): ProjectDocument {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    const locale = document.locales.find(
        (entry) => entry.locale === document.defaultLocale,
    )!;
    locale.messages[item.presentation.nameMessage] = name;
    return document;
}

function requestFor(document: ProjectDocument): PreviewRequest {
    return previewRequestSchema.parse({
        document,
        itemId: `${document.namespace}:${document.items[0]!.id}`,
        viewer: { locale: document.defaultLocale },
        snapshotHash: contentHash(document),
    });
}

function displayName(
    result: Awaited<ReturnType<typeof compilePreviewRequest>>,
) {
    return result.artifact.display?.displayName.runs
        .map((run) => run.text)
        .join("");
}

describe("preview document ownership", () => {
    it("composes the request document even when it has not been saved", async () => {
        const document = editedDocument("Unsaved current draft");

        const result = await compilePreviewRequest(requestFor(document));

        expect(result.stale).toBe(false);
        expect(result.artifact.origin).toBe("mock");
        expect(result.artifact.digests.snapshot).toBe(contentHash(document));
        expect(displayName(result)).toBe("Unsaved current draft");
    });

    it("passes that same request document to the target compiler", async () => {
        const document = editedDocument("Agent-bound current draft");
        const request = requestFor(document);
        const fallback = await compilePreviewRequest(request);
        const compileWithAgent = vi.fn(async () => ({
            ...fallback.artifact,
            origin: "agent" as const,
        }));

        const result = await compilePreviewRequest(request, {
            compileWithAgent,
        });

        expect(compileWithAgent).toHaveBeenCalledWith({
            document,
            itemId: request.itemId,
            viewer: request.viewer,
            snapshotHash: request.snapshotHash,
        });
        expect(result.artifact.origin).toBe("agent");
        expect(result.stale).toBe(false);
        expect(result.agentError).toBeNull();
    });

    it("marks an agent artifact from another snapshot stale", async () => {
        const request = requestFor(editedDocument("Current draft"));
        const fallback = await compilePreviewRequest(request);

        const result = await compilePreviewRequest(request, {
            compileWithAgent: async () => ({
                ...fallback.artifact,
                origin: "agent",
                digests: {
                    ...fallback.artifact.digests,
                    snapshot: contentHash(baselineDocument),
                },
            }),
        });

        expect(result.artifact.origin).toBe("agent");
        expect(result.stale).toBe(true);
    });
});
