import { useEffect } from "react";
import { persistentServerId } from "../../api/serverWorkspace.js";
import { useConnectionStore } from "../../state/connection.js";
import { useEditorStore } from "../../state/store.js";
import {
    startServerWorkspace,
    useServerWorkspaceState,
} from "../../state/serverWorkspace.js";

export function useServerWorkspace(ready: boolean) {
    const info = useConnectionStore((s) => s.info);
    const client = useConnectionStore((s) => s.client);
    const epoch = useEditorStore((s) => s.workspaceEpoch);
    const profile = useServerWorkspaceState();
    const id = persistentServerId(info);
    useEffect(() => {
        if (ready && id) return startServerWorkspace(id, epoch);
        useServerWorkspaceState.setState({
            serverId: null,
            status: "idle",
            epoch: -1,
        });
    }, [ready, id, client, epoch]);
    return (
        !id ||
        (profile.serverId === id &&
            profile.epoch === epoch &&
            profile.status !== "loading" &&
            profile.status !== "idle")
    );
}
