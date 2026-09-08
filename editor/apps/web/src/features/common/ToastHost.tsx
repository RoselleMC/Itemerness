import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
    dismissToast,
    useToasts,
    type ToastNotice,
} from "../../state/toasts.js";
import "./toast.css";

export function ToastHost() {
    const notices = useToasts((state) => state.notices);
    return (
        <div className="toast-stack" data-testid="toast-stack">
            {notices.map((notice) => (
                <Toast key={notice.id} notice={notice} />
            ))}
        </div>
    );
}
function Toast({ notice }: { notice: ToastNotice }) {
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    useEffect(() => {
        if (hovered || focused) return;
        const timer = setTimeout(
            () => dismissToast(notice.id),
            notice.tone === "error" ? 8000 : 4500,
        );
        return () => clearTimeout(timer);
    }, [notice.id, notice.sequence, notice.tone, hovered, focused]);
    const Icon =
        notice.tone === "success"
            ? CheckCircle2
            : notice.tone === "error"
              ? CircleAlert
              : Info;
    return (
        <div
            className="app-toast"
            data-tone={notice.tone}
            data-testid="app-toast"
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                    setFocused(false);
            }}
        >
            <Icon size={18} aria-hidden="true" />
            <span
                role={notice.tone === "error" ? "alert" : "status"}
                aria-atomic="true"
            >
                {notice.message}
            </span>
            <button
                type="button"
                className="icon-button"
                aria-label={t("common.close")}
                data-tooltip={t("common.close")}
                onClick={() => dismissToast(notice.id)}
            >
                <X size={15} />
            </button>
        </div>
    );
}
