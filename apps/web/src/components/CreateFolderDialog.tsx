import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';

interface CreateFolderDialogProps {
  parentId: string | null;
}

export function CreateFolderDialog({ parentId }: CreateFolderDialogProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: () => createFolder({ name, parentId }, accessToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: parentId ? ['folder', parentId] : ['rootFolders'] });
      setOpen(false);
      setName('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>新增資料夾</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增資料夾</DialogTitle>
        </DialogHeader>
        <input
          data-testid="folder-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="資料夾名稱"
        />
        {mutation.isError && <p data-testid="error">{friendlyErrorMessage(mutation.error)}</p>}
        <DialogFooter>
          <Button
            data-testid="submit-create-folder"
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            建立
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
