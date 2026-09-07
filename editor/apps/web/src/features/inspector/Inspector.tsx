import { useEditorStore } from "../../state/store.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { ItemInspector } from "./ItemInspector.js";
import { ThemeInspector } from "./ThemeInspector.js";
import { LayoutInspector } from "./LayoutInspector.js";
import { DataInspector } from "./DataInspector.js";
import { PreviewSettings } from "./PreviewSettings.js";

/**
 * One inspector slot, four editors. The shell keeps the same list | preview | inspector shape in
 * every mode, so switching from editing an item to restyling a theme moves the selection, not the
 * user's mental model of where things are.
 */
export function Inspector({
    preview,
    onOpenDiagnostics,
}: {
    preview: PreviewBundle;
    onOpenDiagnostics: () => void;
}) {
    const mode = useEditorStore((state) => state.mode);
    const settings = (
        <PreviewSettings
            preview={preview}
            onOpenDiagnostics={onOpenDiagnostics}
        />
    );
    switch (mode) {
        case "themes":
            return <ThemeInspector previewSettings={settings} />;
        case "layouts":
            return <LayoutInspector previewSettings={settings} />;
        case "data":
            return <DataInspector previewSettings={settings} />;
        default:
            return (
                <ItemInspector preview={preview} previewSettings={settings} />
            );
    }
}
