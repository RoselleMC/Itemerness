interface FullscreenWindow {
    isFullscreen(): Promise<boolean>;
    isMaximized(): Promise<boolean>;
    setFullscreen(value: boolean): Promise<void>;
    toggleMaximize(): Promise<void>;
}

export function createFullscreenToggle(window: FullscreenWindow) {
    let busy = false;
    let restoreMaximized = false;
    return async () => {
        if (busy) return;
        busy = true;
        try {
            if (await window.isFullscreen()) {
                await window.setFullscreen(false);
                if (restoreMaximized && !(await window.isMaximized()))
                    await window.toggleMaximize();
                restoreMaximized = false;
            } else {
                restoreMaximized = await window.isMaximized();
                // Tao clips maximized borderless client areas to the taskbar work area.
                if (restoreMaximized) await window.toggleMaximize();
                try {
                    await window.setFullscreen(true);
                } catch (error) {
                    if (restoreMaximized && !(await window.isMaximized()))
                        await window.toggleMaximize();
                    throw error;
                }
            }
        } finally {
            busy = false;
        }
    };
}
