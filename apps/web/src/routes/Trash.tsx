import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FileText, Folder, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { friendlyErrorMessage } from '../api/client';
import { listTrash, purgeTrashItem, restoreTrashItem, type TrashItem } from '../api/trash';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';

function TrashRow({ item, onChanged }: { item: TrashItem; onChanged: () => void }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: () => restoreTrashItem(item, accessToken),
    onSuccess: onChanged,
    onError: (err) => setError(friendlyErrorMessage(err)),
  });
  const purge = useMutation({
    mutationFn: () => purgeTrashItem(item, accessToken),
    onSuccess: () => { setPurgeOpen(false); onChanged(); },
    onError: (err) => setError(friendlyErrorMessage(err)),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          {item.resourceType === 'folder' ? <Folder className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          {item.name}
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </TableCell>
      <TableCell>{item.resourceType === 'folder' ? '資料夾（含其內容）' : '文件'}</TableCell>
      <TableCell className="hidden sm:table-cell">{new Date(item.deletedAt).toLocaleString('zh-TW')}</TableCell>
      <TableCell className="w-0 whitespace-nowrap">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => { setError(null); restore.mutate(); }}>
            <RotateCcw className="mr-1 h-4 w-4" />還原
          </Button>
          <Button variant="destructive" size="sm" aria-label={`永久清除 ${item.name}`} onClick={() => { setError(null); setPurgeOpen(true); }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <DeleteConfirmDialog
          open={purgeOpen}
          onOpenChange={setPurgeOpen}
          resourceName={item.name}
          isDeleting={purge.isPending}
          error={error}
          title="永久清除「{name}」？"
          description="這會永久刪除資料庫資料與所有檔案版本，無法還原。"
          confirmLabel="永久清除"
          onConfirm={() => purge.mutate()}
        />
      </TableCell>
    </TableRow>
  );
}

export function Trash() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['trash'], queryFn: () => listTrash(accessToken) });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['trash'] });
    queryClient.invalidateQueries({ queryKey: ['folder'] });
    queryClient.invalidateQueries({ queryKey: ['rootFolders'] });
  };

  if (query.isLoading) return <p className="p-6" data-testid="trash-loading">載入垃圾桶中...</p>;
  if (query.isError) return <p className="p-6 text-destructive">{friendlyErrorMessage(query.error)}</p>;
  const items = query.data ?? [];
  return (
    <main className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 className="text-xl font-bold">垃圾桶</h1>
      <p className="mt-1 text-sm text-muted-foreground">還原會保留原始資料夾位置與權限；永久清除會連同所有檔案版本一併移除。</p>
      {items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-8 text-center text-muted-foreground">垃圾桶是空的</div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border bg-background">
          <Table>
            <TableHeader><TableRow><TableHead>名稱</TableHead><TableHead>類型</TableHead><TableHead className="hidden sm:table-cell">刪除時間</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{items.map((item) => <TrashRow key={`${item.resourceType}-${item.id}`} item={item} onChanged={invalidate} />)}</TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
