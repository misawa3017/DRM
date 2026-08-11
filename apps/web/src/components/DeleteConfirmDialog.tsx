import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: string | null;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  resourceName,
  onConfirm,
  isDeleting,
  error,
  title,
  description,
  confirmLabel = '刪除',
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ? title.replace('{name}', resourceName) : `刪除「${resourceName}」？`}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {description ?? '刪除後這個項目會移至垃圾桶，可由管理員還原或永久清除。'}
        </p>
        {error && (
          <p className="text-sm text-destructive" data-testid="delete-confirm-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete"
            disabled={isDeleting}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
