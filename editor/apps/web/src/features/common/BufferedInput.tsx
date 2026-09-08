import {
    useEffect,
    useId,
    useRef,
    useState,
    type HTMLAttributes,
    type KeyboardEvent,
    type FocusEvent,
} from "react";
import { SuggestionInput } from "./SuggestionInput.js";

/** Keeps unfinished text local while save, blur and Enter share one validated commit. */
export function BufferedInput({
    value,
    label,
    validate,
    onCommit,
    testId,
    inputMode = "text",
    className,
    owner,
    multiline = false,
    suggestions,
    disabled = false,
    readOnly = false,
}: {
    value: string;
    label: string;
    validate(raw: string): string | null;
    onCommit(raw: string): void | boolean;
    testId?: string;
    inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
    className?: string;
    owner?: string;
    multiline?: boolean;
    suggestions?: readonly string[];
    disabled?: boolean;
    readOnly?: boolean;
}) {
    const [draft, setDraft] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const raw = useRef(draft);
    const base = useRef(value);
    const current = useRef({ value, validate, onCommit, owner });
    current.current = { value, validate, onCommit, owner };
    const source = useRef({ value, owner });
    const errorId = useId();
    useEffect(() => {
        window.dispatchEvent(new Event("itemerness:inline-dirty"));
        return () => {
            queueMicrotask(() =>
                window.dispatchEvent(new Event("itemerness:inline-dirty")),
            );
        };
    }, [draft, value, owner]);
    useEffect(() => {
        raw.current = value;
        base.current = value;
        setDraft(value);
        setError(null);
        source.current = { value, owner };
    }, [value, owner]);
    const commit = () => {
        if (
            source.current.value !== current.current.value ||
            source.current.owner !== current.current.owner
        )
            return true;
        if (raw.current === base.current) return true;
        const failure = current.current.validate(raw.current);
        if (failure) {
            setError(failure);
            return false;
        }
        setError(null);
        if (current.current.onCommit(raw.current) === false) return false;
        base.current = raw.current;
        return true;
    };
    const commitRef = useRef(commit);
    commitRef.current = commit;
    useEffect(() => {
        const finish = (event: Event) => {
            if (!commitRef.current()) event.preventDefault();
        };
        window.addEventListener("itemerness:commit-inline", finish);
        return () =>
            window.removeEventListener("itemerness:commit-inline", finish);
    }, []);
    const Input = multiline ? "textarea" : "input";
    const change = (value: string) => {
        raw.current = value;
        setDraft(value);
        setError(null);
    };
    const inputProps = {
        disabled,
        readOnly,
        inputMode,
        className,
        value: draft,
        "aria-label": label,
        "aria-invalid": error ? (true as const) : undefined,
        "aria-describedby": error ? errorId : undefined,
        "data-testid": testId,
        "data-buffered-value": true,
        "data-dirty": draft !== value,
        onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            if (
                !(event.relatedTarget instanceof Element) ||
                !event.relatedTarget.closest("[data-ui-popup]")
            )
                commit();
        },
        onKeyDown: (
            event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => {
            if (event.nativeEvent.isComposing) return;
            const popupOpen =
                suggestions &&
                event.currentTarget.getAttribute("aria-expanded") === "true";
            if (
                popupOpen &&
                (event.key === "Escape" ||
                    (event.key === "Enter" &&
                        event.currentTarget.hasAttribute(
                            "aria-activedescendant",
                        )))
            ) {
                event.stopPropagation();
                return;
            }
            if (event.key === "Enter" && !(multiline && event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                commit();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (
                    "preventBaseUIHandler" in event &&
                    typeof event.preventBaseUIHandler === "function"
                )
                    event.preventBaseUIHandler();
                raw.current = current.current.value;
                base.current = raw.current;
                setDraft(raw.current);
                setError(null);
            }
        },
    };
    return (
        <div className="buffered-field">
            {suggestions && !multiline ? (
                <SuggestionInput
                    {...inputProps}
                    label={label}
                    suggestions={suggestions}
                    onValueChange={change}
                />
            ) : (
                <Input
                    {...inputProps}
                    type={multiline ? undefined : "text"}
                    rows={multiline ? 2 : undefined}
                    onChange={(event) => change(event.target.value)}
                />
            )}
            {error && (
                <span id={errorId} className="error small" role="alert">
                    {error}
                </span>
            )}
        </div>
    );
}
