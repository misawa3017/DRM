import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DeleteConfirmDialog } from '../../src/components/DeleteConfirmDialog';

describe('DeleteConfirmDialog', () => {
  it('shows the resource name and calls onConfirm when the delete button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceName="財務部"
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/財務部/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onOpenChange(false) when cancel is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        resourceName="財務部"
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('取消'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables the delete button while isDeleting is true', () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceName="財務部"
        onConfirm={vi.fn()}
        isDeleting={true}
      />,
    );

    expect(screen.getByTestId('confirm-delete')).toBeDisabled();
  });

  it('renders the error message inside the dialog when provided', () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceName="財務部"
        onConfirm={vi.fn()}
        error="刪除失敗"
      />,
    );

    expect(screen.getByTestId('delete-confirm-error')).toHaveTextContent('刪除失敗');
  });
});
