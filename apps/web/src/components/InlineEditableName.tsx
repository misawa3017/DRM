import { useState } from 'react';

interface InlineEditableNameProps {
  value: string;
  onSave: (newValue: string) => void;
  className?: string;
  ariaLabel: string;
  testId: string;
}

export function InlineEditableName({
  value,
  onSave,
  className,
  ariaLabel,
  testId,
}: InlineEditableNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testId}
        aria-label={ariaLabel}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    }
  };

  return (
    <input
      autoFocus
      className={className}
      data-testid={`${testId}-input`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setEditing(false);
        }
      }}
    />
  );
}
