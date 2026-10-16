import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { placeName } from '../plan/files';
import { tidyName } from '../plan/plan';
import type { Place } from '../plan/types';

/**
 * A place's name as a field: the start's, once there are legs. Nothing is saved while you type:
 * Enter or leaving the field saves the new name once, so it's one step for Undo, and Escape
 * puts the name back.
 */
export function NameField(props: {
  /** The name saved now: the field starts from it, and follows it when it changes. */
  name: string;
  /** Shown while the field is empty: what the place is called without a name. */
  placeholder?: string;
  disabled?: boolean;
  onSave: (name: string) => void;
}) {
  const { name, onSave } = props;
  const [draft, setDraft] = useState(name);
  // The name can change from outside the field (Undo, Rename places), which it then shows.
  const [shown, setShown] = useState(name);
  if (shown !== name) {
    setShown(name);
    setDraft(name);
  }
  // A request that starts as you type (from a click on the map just before) disables the field,
  // which loses focus without a blur. The name goes back: renaming waits, so it can't race it.
  if (props.disabled && draft !== name) setDraft(name);
  // Enter or Escape has dealt with the edit, so leaving the field afterwards saves nothing.
  const handled = useRef(false);
  // Spaces you can't see, at the ends or doubled, make no new name (see tidyName).
  const save = () => tidyName(draft) !== tidyName(name) && onSave(tidyName(draft));
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
      handled.current = true;
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      // Unless it has just closed a menu on the map (see MapView): one key, one thing.
      e.preventDefault();
      setDraft(name);
      handled.current = true;
    }
  }
  return (
    <input
      className="name-field"
      value={draft}
      size={Math.min(Math.max((draft || props.placeholder || '').length, 4) + 1, 40)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => {
        handled.current = false;
        setDraft(e.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (!handled.current) save();
        handled.current = false;
      }}
    />
  );
}

// Whether text can be made editable as plain text only, so a paste can't bring in formatting.
// Firefox before 136 can't: there, a pasted name is made plain when it's saved.
const PLAIN_TEXT_ONLY = (() => {
  try {
    const el = document.createElement('span');
    el.contentEditable = 'plaintext-only';
    return el.contentEditable === 'plaintext-only';
  } catch {
    return false;
  }
})();

/**
 * A place's name in the itinerary. Clicking it (or Enter on it) lets you type over it, and the
 * new name renames the place everywhere it appears in the plan: on Enter or on leaving it, as
 * one step for Undo. Escape puts the name back.
 *
 * You edit the text where it is, rather than in a field, so it wraps and takes the same room
 * either way: nothing moves when you leave it, and a click elsewhere lands where it was aimed.
 */
export function NameInPlace(props: {
  place: Place;
  disabled?: boolean;
  onRename: (name: string) => void;
}) {
  const { place, disabled, onRename } = props;
  const shown = placeName(place);
  const [editing, setEditing] = useState(false);
  // Typing changes the text behind React's back, so each edit ends with a new element.
  const [version, setVersion] = useState(0);
  const text = useRef<HTMLSpanElement>(null);
  // Enter or Escape has dealt with the edit, so leaving it afterwards saves nothing.
  const handled = useRef(false);
  // After Enter or Escape, keyboard focus stays on the name; after a click elsewhere, not.
  const refocus = useRef(false);
  useEffect(() => {
    const el = text.current;
    if (!el) return;
    if (editing) {
      handled.current = false;
      el.focus();
      window.getSelection()?.selectAllChildren(el);
    } else if (refocus.current) {
      refocus.current = false;
      el.focus();
    }
  }, [editing, version]);

  function finish(save: boolean) {
    const typed = tidyName(text.current?.textContent ?? '');
    setEditing(false);
    setVersion((v) => v + 1);
    if (save && typed !== tidyName(shown) && typed !== tidyName(place.name ?? '')) onRename(typed);
  }

  // A request that starts as you type (from a click on the map just before) ends the edit, and
  // the name goes back: renaming waits, so it can't race it.
  if (editing && disabled) {
    setEditing(false);
    setVersion((v) => v + 1);
  }

  if (editing && !disabled) {
    return (
      <span
        key={version}
        ref={text}
        className="place-name editing"
        contentEditable={PLAIN_TEXT_ONLY ? 'plaintext-only' : true}
        suppressContentEditableWarning
        role="textbox"
        aria-label={`New name for ${shown}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handled.current = refocus.current = true;
            finish(true);
          } else if (e.key === 'Escape' && !e.defaultPrevented) {
            // Unless it has just closed a menu on the map (see MapView): one key, one thing.
            e.preventDefault();
            handled.current = refocus.current = true;
            finish(false);
          }
        }}
        onBlur={() => {
          if (handled.current) handled.current = false;
          else finish(true);
        }}
      >
        {shown}
      </span>
    );
  }
  return (
    <span
      key={version}
      ref={text}
      className="place-name"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`Rename ${shown}`}
      title="Rename this place"
      onClick={() => !disabled && setEditing(true)}
      onKeyDown={(e) => {
        if (disabled || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        setEditing(true);
      }}
    >
      {shown}
    </span>
  );
}
