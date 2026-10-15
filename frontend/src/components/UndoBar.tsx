import { type UndoStep, undoText } from '../undo';

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

interface Props {
  /** The changes that can be undone, the latest last. */
  history: UndoStep[];
  onUndo: () => void;
  /** Whether there are legs to clear. */
  canClear: boolean;
  onClear: () => void;
  disabled?: boolean;
}

/** Undo and Clear plan, kept in reach at the bottom of the panel however far it's scrolled. */
export function UndoBar({ history, onUndo, canClear, onClear, disabled }: Props) {
  const text = undoText(history);
  return (
    <div className="undo-bar row">
      <button
        type="button"
        className="secondary"
        disabled={disabled || !history.length}
        title={history.length ? `${text} (${SHORTCUT})` : undefined}
        aria-keyshortcuts="Control+Z Meta+Z"
        onClick={onUndo}
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
