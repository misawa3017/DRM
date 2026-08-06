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
import { uploadDocument, uploadVersion } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';

export type UploadDialogProps =
  { mode: 'new-document'; folderId: string } | { mode: 'new-version'; documentId: string };

export function UploadDialog(props: UploadDialogProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('file is required');
      if (props.mode === 'new-document') {
        return uploadDocument(
          { folderId: props.folderId, name: name || file.name, file },
          accessToken,
        );
      }
      return uploadVersion(props.documentId, file, accessToken);
    },
    onSuccess: () => {
      if (props.mode === 'new-document') {
        queryClient.invalidateQueries({ queryKey: ['folder', props.folderId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['document', props.documentId] });
        queryClient.invalidateQueries({ queryKey: ['documentVersions', props.documentId] });
      }
      setOpen(false);
      setFile(null);
      setName('');
    },
  });

  const title = props.mode === 'new-document' ? '上傳新文件' : '上傳新版本';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{title}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {props.mode === 'new-document' && (
          <input
            data-testid="document-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文件名稱（留空則用檔名）"
          />
        )}
        <input
          data-testid="file-input"
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {mutation.isError && <p data-testid="error">{friendlyErrorMessage(mutation.error)}</p>}
        <DialogFooter>
          <Button
            data-testid="submit-upload"
            disabled={!file || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            上傳
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
