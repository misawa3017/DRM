import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listRootFolders } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { CreateFolderDialog } from '../components/CreateFolderDialog';

export function RootFolders() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';

  const query = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: !!accessToken,
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folders = query.data ?? [];

  return (
    <div>
      <h1>資料夾</h1>
      <CreateFolderDialog parentId={null} />
      {folders.length === 0 ? (
        <p data-testid="empty">目前沒有你可以存取的資料夾，請聯絡管理員</p>
      ) : (
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
                  <Link to={`/folders/${folder.id}`}>{folder.name}</Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
