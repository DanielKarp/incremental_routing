import { useEffect, useRef } from 'react';
import { type UndoLabel, type UndoStep, undoText } from '../undo';

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

// Changes made with a button that goes with them: Remove (and the legs beyond), Merge into one…
// and Clear plan.
const BUTTON_GOES: UndoLabel[] = ['remove', 'merge', 'clear plan'];

interface Props {
  /** The changes that can be undone, the latest last. */
  history: UndoStep[];
  /** Undo the latest change, or back to before `step` and the changes made since. */
  onUndo: (step?: UndoStep) => void;
  /** Whether there are legs to clear. */
  canClear: boolean;
  onClear: () => void;
  disabled?: boolean;
}

/** Undo and Clear plan, kept in reach at the bottom of the panel however far it's scrolled. */
export function UndoBar({ history, onUndo, canClear, onClear, disabled }: Props) {
  const text = undoText(history);
  const undoButton = useRef<HTMLButtonElement>(null);
  // After a change whose button has gone, keyboard focus comes to Undo, which now says what it
  // would undo, rather than going back to the top of the page.
  const steps = useRef(history.length);
  const last = history[history.length - 1];
  // The change Undo named as you pressed it. Leaving a name or time you were typing, to press
  // it, saves that first, as a change of its own; the click undoes it along with the one named.
  const pressed = useRef<UndoStep | undefined>(undefined);
  useEffect(() => {
    const added = history.length > steps.current;
    steps.current = history.length;
    if (!added || !last || !BUTTON_GOES.includes(last.label)) return;
    if (document.activeElement === document.body) undoButton.current?.focus();
  }, [history.length, last]);
  return (
    <div className="undo-bar row">
      <button
        ref={undoButton}
        type="button"
        className="secondary"
        disabled={disabled || !history.length}
        title={history.length ? `${text} (${SHORTCUT})` : undefined}
        aria-keyshortcuts="Control+Z Meta+Z"
        onKeyDown={(e) => {
          // Holding Enter down undoes one step, as holding Ctrl+Z does, even when the button you
          // were holding it on has just gone and left the focus here.
          if (e.key === 'Enter' && e.repeat) e.preventDefault();
        }}
        onPointerDown={() => {
          pressed.current = last;
        }}
        onClick={(e) => {
          // From the keyboard (detail 0), focus is on the button already: no field was left.
          onUndo(e.detail ? pressed.current : undefined);
          pressed.current = undefined;
        }}
      >
        {text}
      </button>
      {canClear && (
        <button type="button" className="secondary" disabled={disabled} onClick={onClear}>
          Clear plan
        </button>
      )}
    </div>
  );
}
