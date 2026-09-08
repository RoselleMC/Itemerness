import { create } from "zustand";

export interface ToastNotice {
    id: string;
    message: string;
    tone: "success" | "error" | "info";
    sequence: number;
}
let sequence = 0;
export const useToasts = create<{ notices: ToastNotice[] }>(() => ({
    notices: [],
}));

export function notify(
    message: string,
    tone: ToastNotice["tone"] = "success",
    id = "operation",
) {
    useToasts.setState((state) => ({
        notices: [
            ...state.notices.filter((notice) => notice.id !== id),
            { id, message, tone, sequence: ++sequence },
        ].slice(-3),
    }));
}
export function dismissToast(id: string) {
    useToasts.setState((state) => ({
        notices: state.notices.filter((notice) => notice.id !== id),
    }));
}
