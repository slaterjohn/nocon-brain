"use client";

import * as React from "react";
import { Globe, Search, FileText, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { get } from "@/lib/api";
import { readSuggestions, suggestionQuery, type Suggestion } from "@/lib/search";

const KIND_ICON = { query: Clock, title: FileText, domain: Globe, term: Search, other: Search } as const;
const KIND_TEXT = { query: "Earlier search", title: "Saved page", domain: "Site", term: "Word", other: "Suggestion" } as const;

/**
 * Search field with autocomplete, following the ARIA 1.2 combobox pattern (list autocomplete, focus stays in the input,
 * `aria-activedescendant` points at the highlighted option). Suggestions come from the local archive only, debounced.
 */
export function SearchBox({
  id,
  label,
  value,
  onChange,
  onSubmit,
  size = "md",
  autoFocus,
  placeholder = "Search your saved pages",
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (q: string) => void;
  size?: "md" | "lg";
  autoFocus?: boolean;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const listId = `${id}-listbox`;
  const [items, setItems] = React.useState<Suggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  // Suggestions are fetched for typed text only. Choosing a suggestion fills the box without fetching again.
  const skip = React.useRef(false);
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useCallback(
    (el: HTMLInputElement | null) => {
      innerRef.current = el;
      if (typeof inputRef === "function") inputRef(el);
      else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    },
    [inputRef],
  );

  React.useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const q = value.trim();
    if (!q || document.activeElement !== innerRef.current) {
      setItems([]);
      setOpen(false);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      get<unknown>(`/api/search/suggestions?q=${encodeURIComponent(q)}&limit=8`)
        .then((raw) => {
          if (ctl.signal.aborted) return;
          const list = readSuggestions(raw).suggestions.slice(0, 8);
          setItems(list);
          setActive(-1);
          setOpen(list.length > 0);
        })
        .catch(() => {
          if (!ctl.signal.aborted) {
            setItems([]);
            setOpen(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [value]);

  function choose(s: Suggestion) {
    const q = suggestionQuery(s);
    skip.current = true;
    onChange(q);
    setOpen(false);
    setActive(-1);
    onSubmit(q);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : items.length - 1);
        return;
      }
      const n = items.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        choose(items[active]!);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const lg = size === "lg";
  return (
    <div className="relative min-w-0 flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search className={cn("pointer-events-none absolute left-3.5 text-muted-foreground", lg ? "top-3.5 size-5" : "top-2.5 size-4")} aria-hidden="true" />
      <input
        id={id}
        ref={setRefs}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-keyshortcuts="/"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        enterKeyHint="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => items.length > 0 && setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        data-testid="search-input"
        className={cn(
          "w-full rounded-full border border-input bg-background text-foreground shadow-xs outline-none placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
          lg ? "h-12 pr-5 pl-12 text-base" : "h-10 pr-4 pl-10 text-sm",
        )}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        hidden={!open}
        data-testid="suggestions"
        className="absolute z-30 mt-1.5 max-h-80 w-full overflow-auto rounded-2xl border bg-popover py-1.5 text-popover-foreground shadow-lg"
      >
        {items.map((s, i) => {
          const Icon = KIND_ICON[s.kind];
          return (
            <li
              key={`${s.kind}:${s.text}`}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep focus in the input while the pointer chooses.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(s)}
              onMouseMove={() => active !== i && setActive(i)}
              className={cn("flex cursor-pointer items-center gap-3 px-4 py-2 text-sm", i === active && "bg-accent text-accent-foreground")}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{s.text}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{KIND_TEXT[s.kind]}</span>
            </li>
          );
        })}
      </ul>
      <div role="status" className="sr-only" data-testid="suggestions-status">
        {open && items.length > 0 ? `${items.length} ${items.length === 1 ? "suggestion" : "suggestions"} available. Use the up and down arrow keys to review, Enter to search.` : ""}
      </div>
    </div>
  );
}
