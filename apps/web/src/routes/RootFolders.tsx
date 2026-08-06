import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listRootFolders } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { getRolesFromToken } from '../lib/jwt';

export function RootFolders() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const isAdmin = getRolesFromToken(accessToken).includes('admin');

  const query = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: !!accessToken,
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folders = query.data ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">資料夾</h1>
        {isAdmin && <CreateFolderDialog parentId={null} />}
      </div>
      {folders.length === 0 ? (
        <div
          className="rounded-lg border bg-background p-12 text-center text-muted-foreground"
          data-testid="empty"
        >
          <Folder className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p>目前沒有你可以存取的資料夾，請聯絡管理員</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名稱</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {folders.map((folder) => (
                <TableRow key={folder.id}>
                  <TableCell>
                    <Link to={`/folders/${folder.id}`} className="flex items-center gap-2">
                      <Folder className="h-4 w-4 text-muted-foreground" />
                      {folder.name}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
