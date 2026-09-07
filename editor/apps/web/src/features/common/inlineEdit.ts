/** Complete an in-place draft before commands that leave or save the editing surface. */
export function commitInlineEditor() {
    window.dispatchEvent(new Event("itemerness:commit-inline"));
}
