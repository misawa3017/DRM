import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { InlineEditableName } from '../../src/components/InlineEditableName';

describe('InlineEditableName', () => {
  it('shows the value as a button until clicked, then shows an editable input', () => {
    render(<InlineEditableName value="財務部" onSave={vi.fn()} ariaLabel="編輯名稱" testId="name" />);

    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('name'));

    expect(screen.getByRole('textbox')).toHaveValue('財務部');
  });

  it('calls onSave with the trimmed new value on Enter', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  新名字  ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSave).toHaveBeenCalledWith('新名字');
  });

  it('does not call onSave if the value is unchanged', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('discards the draft and does not call onSave on Escape', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不要這個' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
