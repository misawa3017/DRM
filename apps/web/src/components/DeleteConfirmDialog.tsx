import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: string | null;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  resourceName,
  onConfirm,
  isDeleting,
  error,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>刪除「{resourceName}」？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          刪除後這個項目就不會再出現在清單裡，目前介面上還沒有提供還原功能。
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
            刪除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
