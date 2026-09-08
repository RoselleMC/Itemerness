/** Complete an in-place draft before commands that leave or save the editing surface. */
export function commitInlineEditor() {
    return window.dispatchEvent(
        new Event("itemerness:commit-inline", { cancelable: true }),
    );
}

export function hasPendingInlineEdits() {
    return !!document.querySelector('[data-buffered-value][data-dirty="true"]');
}
