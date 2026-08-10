import { useState } from 'react';
import { Button } from './ui/button';

interface WatermarkSettingProps {
  value: boolean | null | undefined;
  template?: string | null;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
  onTemplateChange?: (value: string | null) => void;
}

function serialize(value: boolean | null | undefined): string {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'inherit';
}

export function WatermarkSetting({
  value,
  template,
  disabled,
  onChange,
  onTemplateChange,
}: WatermarkSettingProps) {
  const [templateMode, setTemplateMode] = useState(template == null ? 'inherit' : 'custom');
  const [draft, setDraft] = useState(template ?? '{{email}} | {{datetime}} | {{ip}}');

  return (
    <div className="grid gap-4 text-sm">
      <label className="grid gap-1.5">
        <span className="font-medium">動態浮水印</span>
        <select
          aria-label="動態浮水印"
          value={serialize(value)}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === 'inherit' ? null : next === 'enabled');
          }}
          className="h-10 rounded-md border bg-background px-3"
        >
          <option value="inherit">繼承上層設定（預設開啟）</option>
          <option value="enabled">開啟</option>
          <option value="disabled">關閉</option>
        </select>
      </label>
      {onTemplateChange && (
        <div className="grid gap-1.5">
          <span className="font-medium">浮水印內容</span>
          <select
            aria-label="浮水印內容來源"
            value={templateMode}
            disabled={disabled}
            onChange={(event) => {
              const mode = event.target.value;
              setTemplateMode(mode);
              if (mode === 'inherit') onTemplateChange(null);
            }}
            className="h-10 rounded-md border bg-background px-3"
          >
            <option value="inherit">繼承上層範本</option>
            <option value="custom">自訂範本</option>
          </select>
          {templateMode === 'custom' && (
            <>
              <textarea
                aria-label="浮水印範本"
                value={draft}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-20 rounded-md border bg-background px-3 py-2 font-mono text-xs"
              />
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  可用變數：{'{{email}}'}、{'{{datetime}}'}、{'{{ip}}'}、{'{{documentName}}'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || draft.trim().length === 0}
                  onClick={() => onTemplateChange(draft.trim())}
                >
                  儲存範本
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
