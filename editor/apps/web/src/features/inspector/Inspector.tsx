import { useEditorStore } from "../../state/store.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { ItemInspector } from "./ItemInspector.js";
import { ThemeInspector } from "./ThemeInspector.js";
import { LayoutInspector } from "./LayoutInspector.js";
import { DataInspector } from "./DataInspector.js";
import { RunoRpgTemplateInspector } from "./RunoRpgTemplateInspector.js";
import { ItemTemplateInspector } from "./ItemTemplateInspector.js";

/**
 * One inspector slot, four editors. The shell keeps the same list | preview | inspector shape in
 * every mode, so switching from editing an item to restyling a theme moves the selection, not the
 * user's mental model of where things are.
 */
export function Inspector({ preview }: { preview: PreviewBundle }) {
    const mode = useEditorStore((state) => state.mode);
    const selectedItemId = useEditorStore((state) => state.selectedItemId);
    switch (mode) {
        case "templates":
            return <ItemTemplateInspector />;
        case "themes":
            return <ThemeInspector />;
        case "layouts":
            return <LayoutInspector />;
        case "data":
            return <DataInspector />;
        default:
            return selectedItemId?.startsWith("runocraft:") ? (
                <RunoRpgTemplateInspector preview={preview} />
            ) : (
                <ItemInspector preview={preview} />
            );
    }
}
