import { isDeepStrictEqual } from "node:util";
import { readFontMetricsArtifact } from "../packages/mc-assets/src/ifm.js";
import {
    PresentationFonts,
    composeLocalPreview,
} from "../packages/mc-render/src/index.js";
import type {
    PreviewDisplay,
    PreviewViewer,
    ProjectDocument,
} from "../packages/protocol/src/index.js";

const baseUrl = process.argv[2] ?? "http://172.20.0.38:8080";
const documentResponse = await fetch(`${baseUrl}/api/v1/document`);
if (!documentResponse.ok) {
    throw new Error(`Document request failed: HTTP ${documentResponse.status}`);
}
const envelope = (await documentResponse.json()) as {
    document: ProjectDocument;
    snapshotHash: string;
};
const profile = envelope.document.assetProfiles.find(
    (entry) => entry.id === "itemerness:example-pack-v1",
);
if (!profile)
    throw new Error("Missing itemerness:example-pack-v1 asset profile");

const viewer: PreviewViewer = {
    locale: "zh_cn",
    requestedTheme: null,
    assetProfile: profile.id,
    capabilities: [...profile.capabilities],
    metricsRevision: profile.metricsRevision,
    resourcePackLoaded: true,
    managesVanillaTooltipLines: true,
    direction: "LEFT_TO_RIGHT",
};
const itemId = "itemerness:ember-blade";

const metricsResponse = await fetch(`${baseUrl}/api/v1/font-metrics/1.21.11`);
if (!metricsResponse.ok) {
    throw new Error(
        `Font metrics request failed: HTTP ${metricsResponse.status}`,
    );
}
const fonts = new PresentationFonts({
    artifact: readFontMetricsArtifact(
        new Uint8Array(await metricsResponse.arrayBuffer()),
    ),
    fonts: envelope.document.fonts,
    glyphs: envelope.document.glyphs,
    spacing: envelope.document.spacing,
});
const local = composeLocalPreview({
    document: envelope.document,
    itemId,
    viewer,
    fonts,
});

const previewResponse = await fetch(`${baseUrl}/api/v1/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        document: envelope.document,
        itemId,
        viewer,
        snapshotHash: envelope.snapshotHash,
    }),
});
if (!previewResponse.ok) {
    throw new Error(`Preview request failed: HTTP ${previewResponse.status}`);
}
const previewEnvelope = (await previewResponse.json()) as {
    artifact: { origin: string; display: PreviewDisplay };
    stale: boolean;
};
const server = previewEnvelope.artifact.display;

const lineGeometry = (display: PreviewDisplay) => ({
    name: display.displayName.logicalWidthPixels,
    lore: display.lore.map((line) => line.logicalWidthPixels),
    runCounts: display.lore.map((line) => line.runs.length),
    texts: display.lore.map((line) =>
        line.runs.map((run) => run.text).join(""),
    ),
});
const localGeometry = lineGeometry(local.display);
const serverGeometry = lineGeometry(server);
const displayEqual = isDeepStrictEqual(local.display, server);
const geometryEqual = isDeepStrictEqual(localGeometry, serverGeometry);
const differences: Array<{ path: string; local: unknown; server: unknown }> =
    [];
const compare = (localValue: unknown, serverValue: unknown, path: string) => {
    if (differences.length >= 40 || Object.is(localValue, serverValue)) return;
    if (
        typeof localValue !== "object" ||
        localValue === null ||
        typeof serverValue !== "object" ||
        serverValue === null
    ) {
        differences.push({ path, local: localValue, server: serverValue });
        return;
    }
    const localRecord = localValue as Record<string, unknown>;
    const serverRecord = serverValue as Record<string, unknown>;
    for (const key of new Set([
        ...Object.keys(localRecord),
        ...Object.keys(serverRecord),
    ])) {
        compare(localRecord[key], serverRecord[key], `${path}.${key}`);
    }
};
compare(local.display, server, "display");
const report = {
    itemId,
    origin: previewEnvelope.artifact.origin,
    stale: previewEnvelope.stale,
    displayEqual,
    geometryEqual,
    differences,
    localGeometry,
    serverGeometry,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!displayEqual || !geometryEqual || previewEnvelope.stale) process.exit(1);
