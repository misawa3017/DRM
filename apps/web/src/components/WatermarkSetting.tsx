interface WatermarkSettingProps {
  value: boolean | null | undefined;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
}

function serialize(value: boolean | null | undefined): string {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'inherit';
}

export function WatermarkSetting({ value, disabled, onChange }: WatermarkSettingProps) {
  return (
    <label className="grid gap-1.5 text-sm">
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
  );
}
