import { create } from "zustand";
import type { ProjectDocument } from "@itemerness/protocol";

export interface ItemCreationRequest {
    owner: string;
    document: ProjectDocument;
}

export const useItemCreationDialog = create<{
    request: ItemCreationRequest | null;
}>(() => ({ request: null }));

export function closeItemCreation() {
    useItemCreationDialog.setState({ request: null });
}
