/**
 * Proves the paired Minecraft server still compiles a document that carries the template registry.
 *
 * `ProjectDocumentCodec` rejects unknown root keys, which is the whole reason templates live under
 * `extensions` instead of beside `items`. That claim is only worth as much as a live compile: this
 * asks the agent to render one item twice, once without the registry and once with it, and reports
 * whether the two artifacts agree.
 *
 * Usage: tsx scripts/verify-agent-accepts-templates.mts <base-url>
 */
import {
    contentHash,
    previewArtifactSchema,
    projectDocumentSchema,
    type ProjectDocument,
} from "@itemerness/protocol";

const baseUrl = process.argv[2];
if (!baseUrl) {
    throw new Error(
        "usage: tsx scripts/verify-agent-accepts-templates.mts <base-url>",
    );
}

const TEMPLATE = {
    uuid: "9f1d0c2a-1f5b-4a6d-9c3e-7f0b2d4e6a81",
    id: "runocraft:template-live-probe",
    displayName: "上线探针模板",
    description: "",
    category: "sword",
    enabled: true,
    revision: 0,
    material: "minecraft:netherite_sword",
    layout: "itemerness:equipment",
    theme: "itemerness:ember",
    mode: "unique",
    maxStackSize: 1,
    unbreakable: true,
    itemTier: "unique",
    itemLevel: 30,
    itemPrefix: "",
    baseModifiers: [],
    baseSkills: [],
    presentationBlocks: [],
    presentationMessages: {},
};

async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...(init?.headers ?? {}),
        },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(
            `${path}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 400)}`,
        );
    }
    return body;
}

const envelope = (await json("/api/v1/document")) as { document: unknown };
const document = projectDocumentSchema.parse(envelope.document);
const item = document.items[0];
if (!item) throw new Error("the live draft has no item to preview");
const itemId = `${document.namespace}:${item.id}`;

const status = (await json("/api/v1/agent/status")) as {
    connected: boolean;
    serverId: string | null;
};
if (!status.connected) {
    throw new Error("no agent is paired; this check needs a live server");
}

async function compile(candidate: ProjectDocument): Promise<{
    origin: string;
    lines: number;
    diagnostics: number;
}> {
    const body = (await json("/api/v1/preview", {
        method: "POST",
        body: JSON.stringify({
            document: candidate,
            itemId,
            snapshotHash: contentHash(candidate),
            targetServerId: status.serverId,
            viewer: {
                locale: candidate.defaultLocale,
                requestedTheme: null,
                assetProfile: null,
                capabilities: [],
                metricsRevision: null,
                resourcePackLoaded: false,
                managesVanillaTooltipLines: false,
                direction: "LEFT_TO_RIGHT",
            },
        }),
    })) as { artifact: unknown };
    const artifact = previewArtifactSchema.parse(body.artifact);
    return {
        origin: artifact.origin,
        lines: artifact.display.lore.length,
        diagnostics: artifact.diagnostics.length,
    };
}

const plain = await compile(document);
const withTemplates = await compile({
    ...document,
    extensions: {
        ...(document.extensions ?? {}),
        "itemerness:item-templates": {
            version: 1,
            templates: [TEMPLATE],
            bindings: [],
        },
    },
});

process.stdout.write(
    `item              ${itemId}\n` +
        `without registry  origin=${plain.origin} lore=${plain.lines} diagnostics=${plain.diagnostics}\n` +
        `with registry     origin=${withTemplates.origin} lore=${withTemplates.lines} diagnostics=${withTemplates.diagnostics}\n`,
);

if (plain.origin !== "agent") {
    throw new Error(
        `the paired server did not compile the plain document (origin ${plain.origin}); this check proves nothing`,
    );
}
if (withTemplates.origin !== "agent") {
    throw new Error(
        "the agent refused the document once the template registry was present",
    );
}
if (withTemplates.lines !== plain.lines) {
    throw new Error("the registry changed what the server rendered");
}
process.stdout.write(
    "\nok  the agent compiles a document carrying templates\n",
);
