"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import "./creatable-select.css";

export type CreatableOption = { value: string; label: string };
export type CreatableSelectProps = {
  options: CreatableOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  label: string;
  required?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  onCreate?: (typedLabel: string) => void;
  createLabel?: string;
  id?: string;
};

type Placement = { top: number; left: number; width: number; maxHeight: number; above: boolean };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();

/** Creation is an action: only existing option values ever reach onChange. */
export default function CreatableSelect({ options, value, onChange, label, required = false, multiple = false, disabled = false, onCreate, createLabel = "Create new item", id }: CreatableSelectProps) {
  const generatedId = useId();
  const inputId = id || `creatable-${generatedId}`;
  const listboxId = `${inputId}-options`;
  const hintId = `${inputId}-hint`;
  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const items = useMemo(() => {
    const seen = new Set<string>();
    return options.filter(option => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  }, [options]);
  const selectedValues = useMemo(() => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return [...new Set(values.filter(item => item !== ""))];
  }, [value]);
  const selectedItems = selectedValues.map(selected => items.find(item => item.value === selected) || { value: selected, label: selected });
  const filteredItems = useMemo(() => {
    const search = normalize(query);
    return search ? items.filter(option => normalize(option.label).includes(search) || normalize(option.value).includes(search)) : items;
  }, [items, query]);
  const canCreate = Boolean(onCreate) && !disabled;
  const typedLabel = query.trim();
  const exactMatch = typedLabel && items.some(item => normalize(item.label) === normalize(typedLabel));
  const creationName = typedLabel && !exactMatch ? `Create “${typedLabel}”` : createLabel;
  const itemCount = filteredItems.length + (canCreate ? 1 : 0);
  const optionId = (index: number) => `${listboxId}-item-${index}`;
  const activeId = open && activeIndex >= 0 && activeIndex < itemCount ? optionId(activeIndex) : undefined;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => { if (inputRef.current?.isConnected) inputRef.current.focus({ preventScroll: true }); });
  }, []);
  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (returnFocus) focusInput();
  }, [focusInput]);

  useEffect(() => {
    const input = inputRef.current;
    if (input) input.setCustomValidity(required && !selectedValues.length ? `Please select ${label.toLowerCase()}.` : "");
  }, [label, required, selectedValues.length]);
  useEffect(() => { if (disabled) close(); }, [disabled, close]);
  useEffect(() => {
    if (!open) return;
    setActiveIndex(index => itemCount ? Math.min(Math.max(index, 0), itemCount - 1) : -1);
  }, [open, itemCount]);

  // A body portal keeps the list visible outside scrollable record forms.
  useLayoutEffect(() => {
    if (!open || disabled) return;
    let frame = 0;
    const measure = () => {
      const control = controlRef.current;
      if (!control) return;
      const rect = control.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportHeight = viewport?.height || window.innerHeight;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportBottom = viewportTop + viewportHeight;
      if (rect.bottom <= viewportTop || rect.top >= viewportBottom) { close(); return; }
      // Close if its form has scrolled the anchor out of sight.
      for (let parent = control.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) { close(); return; }
        }
      }
      const below = viewportBottom - rect.bottom - 16;
      const aboveSpace = rect.top - viewportTop - 16;
      const desiredHeight = Math.min(330, 43 + Math.min(filteredItems.length, 6) * 38 + (canCreate ? 46 : 0));
      const above = below < desiredHeight && aboveSpace > below;
      const width = Math.min(Math.max(rect.width, 220), Math.max(160, viewportWidth - 20));
      const next: Placement = {
        top: above ? rect.top - 6 : rect.bottom + 6,
        left: Math.max(viewportLeft + 10, Math.min(rect.left, viewportLeft + viewportWidth - width - 10)),
        width,
        maxHeight: Math.max(80, Math.min(330, above ? aboveSpace : below)),
        above,
      };
      setPlacement(previous => previous && Object.keys(next).every(key => previous[key as keyof Placement] === next[key as keyof Placement]) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (controlRef.current) observer?.observe(controlRef.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, disabled, filteredItems.length, canCreate, close]);

  useEffect(() => {
    if (!open) return;
    const clickAway = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !controlRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", clickAway, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", clickAway, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, close]);
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listboxId]);

  function show(direction: "first" | "last" = "first") {
    if (disabled) return;
    setQuery("");
    setOpen(true);
    const selectedIndex = items.findIndex(item => selectedValues.includes(item.value));
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : direction === "last" ? items.length + (canCreate ? 1 : 0) - 1 : items.length || canCreate ? 0 : -1);
  }
  function choose(option: CreatableOption) {
    if (disabled) return;
    if (multiple) {
      onChange(selectedValues.includes(option.value) ? selectedValues.filter(selected => selected !== option.value) : [...selectedValues, option.value]);
      setQuery("");
      setActiveIndex(items.findIndex(item => item.value === option.value));
      focusInput();
    } else {
      onChange(option.value);
      close(true);
    }
  }
  function createItem() {
    if (!onCreate || disabled) return;
    // Let the parent remember this field before it moves focus into its dialog.
    inputRef.current?.focus({ preventScroll: true });
    close();
    // The caller owns the create dialog and its focus after this callback.
    onCreate(typedLabel && !exactMatch ? typedLabel : "");
  }
  function removeValue(selected: string) {
    if (disabled) return;
    onChange(multiple ? selectedValues.filter(item => item !== selected) : "");
    focusInput();
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) show(event.key === "ArrowUp" ? "last" : "first");
      else if (event.altKey && event.key === "ArrowUp") close(true);
      else setActiveIndex(index => !itemCount ? -1 : index < 0 ? event.key === "ArrowDown" ? 0 : itemCount - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + itemCount) % itemCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) show();
      else if (activeIndex >= 0 && activeIndex < filteredItems.length) choose(filteredItems[activeIndex]);
      else if (canCreate && activeIndex === filteredItems.length) createItem();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab" && open) close();
    else if ((event.key === "Home" || event.key === "End") && open && !query) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : itemCount - 1);
    } else if (event.key === "Backspace" && multiple && !query && selectedValues.length) {
      event.preventDefault();
      removeValue(selectedValues[selectedValues.length - 1]);
    }
  }

  const menu = open && placement && typeof document !== "undefined" ? createPortal(
    <div ref={popoverRef} className="csel-popover" style={{ top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight, transform: placement.above ? "translateY(-100%)" : undefined }}>
      <div className="csel-menu-heading"><Search size={12} /><span>{query ? `Results for “${query}”` : `Choose ${label.toLowerCase()}`}</span><small>{filteredItems.length}</small></div>
      <div id={listboxId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="csel-listbox">
        <div className="csel-option-scroll" role="presentation">
          {filteredItems.length ? filteredItems.map((option, index) => <button key={option.value} id={optionId(index)} type="button" role="option" tabIndex={-1} aria-selected={selectedValues.includes(option.value)} className={`csel-option ${activeIndex === index ? "csel-option-active" : ""} ${selectedValues.includes(option.value) ? "csel-option-selected" : ""}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}><span>{option.label}</span>{selectedValues.includes(option.value) && <Check size={14} />}</button>) : <div className="csel-empty"><Search size={19} strokeWidth={1.5} /><span>{query ? "No matching items" : "No items yet"}</span><small>{canCreate ? "Create one to keep things moving." : "Try a different search."}</small></div>}
        </div>
        {canCreate && <button id={optionId(filteredItems.length)} type="button" role="option" tabIndex={-1} aria-selected={false} className={`csel-create ${activeIndex === filteredItems.length ? "csel-create-active" : ""}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(filteredItems.length)} onClick={createItem}><span className="csel-create-icon"><Plus size={14} /></span><span title={creationName}>{creationName}</span><small>New</small></button>}
      </div>
    </div>, document.body,
  ) : null;

  return <div className={`csel-root ${disabled ? "csel-disabled" : ""}`}>
    <div ref={controlRef} className={`csel-control ${open ? "csel-open" : ""} ${multiple ? "csel-multiple" : ""}`} onClick={event => { if (disabled || (event.target instanceof Element && event.target.closest("button"))) return; if (!open) show(); inputRef.current?.focus({ preventScroll: true }); }}>
      {multiple && selectedItems.map(item => <span className="csel-chip" key={item.value}><span title={item.label}>{item.label}</span><button type="button" aria-label={`Remove ${item.label}`} disabled={disabled} onClick={event => { event.stopPropagation(); removeValue(item.value); }}><X size={11} /></button></span>)}
      <input ref={inputRef} id={inputId} className="csel-input" type="text" role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? listboxId : undefined} aria-haspopup="listbox" aria-autocomplete="list" aria-activedescendant={activeId} aria-required={required} aria-describedby={hintId} required={required && !selectedValues.length} disabled={disabled} autoComplete="off" autoCorrect="off" spellCheck={false} value={open ? query : multiple ? "" : selectedItems[0]?.label || ""} placeholder={open ? `Search ${label.toLowerCase()}…` : multiple && selectedItems.length ? "Add another…" : `Select ${label.toLowerCase()}…`} onFocus={event => { if (!open && !multiple) event.currentTarget.select(); }} onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); }} onKeyDown={onKeyDown} onInvalid={() => { show(); focusInput(); }} />
      {!multiple && selectedValues.length > 0 && !required && !disabled && <button type="button" className="csel-clear" aria-label={`Clear ${label.toLowerCase()}`} onMouseDown={event => event.preventDefault()} onClick={() => removeValue(selectedValues[0])}><X size={13} /></button>}
      <button type="button" className="csel-chevron" disabled={disabled} tabIndex={-1} aria-label={`${open ? "Close" : "Open"} ${label.toLowerCase()} options`} aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { if (open) close(true); else { show(); focusInput(); } }}><ChevronDown size={15} /></button>
    </div>
    <span id={hintId} className="csel-sr-only">{multiple ? `${selectedItems.length} selected. ` : ""}Type to search. Use arrow keys to browse and Enter to select.{canCreate ? " Create new items at the end of the list." : ""}</span>
    {menu}
  </div>;
}
