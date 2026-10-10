import { useEffect, useRef } from 'react';
import { downloadText } from '../download';
import { planFileName, planToCsv, planToIcs, planToJson } from '../plan/files';
import type { Plan, PlanIssue } from '../plan/types';
import { PlanTable } from './PlanTable';

interface Props {
  plan: Plan;
  issues: PlanIssue[];
  onClose: () => void;
}

/** Full-width view of the finished trip, with printing and exports. */
export function PlanSummary({ plan, issues, onClose }: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="summary-backdrop" onClick={onClose}>
      <div
        className="summary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="summary-header">
          <h2 id="summary-title">Trip summary</h2>
          <button ref={closeButton} type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="row wrap">
          <button type="button" onClick={() => window.print()}>
            Print
          </button>
          <button
            type="button"
            className="secondary"
            title="Spreadsheet: one row per leg"
            onClick={() => downloadText(planFileName(plan, 'csv'), planToCsv(plan), 'text/csv')}
          >
            Download CSV
          </button>
          <button
            type="button"
            className="secondary"
            title="Calendar file: one event per leg"
            onClick={() =>
              downloadText(planFileName(plan, 'ics'), planToIcs(plan), 'text/calendar')
            }
          >
            Add to calendar (.ics)
          </button>
          <button
            type="button"
            className="secondary"
            title="Save the plan to load it again later"
            onClick={() =>
              downloadText(planFileName(plan, 'json'), planToJson(plan), 'application/json')
            }
          >
            Save plan (.json)
          </button>
        </div>
        <PlanTable plan={plan} issues={issues} />
      </div>
    </div>
  );
}
