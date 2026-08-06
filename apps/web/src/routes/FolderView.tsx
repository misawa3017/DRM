import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';

export function FolderView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';

  const query = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId, accessToken),
    enabled: !!folderId,
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folder = query.data!;

  return (
    <div>
      <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
      <h1>{folder.name}</h1>
      <CreateFolderDialog parentId={folder.id} />
      <UploadDialog mode="new-document" folderId={folder.id} />

      <h2>子資料夾</h2>
      <Table>
        <TableBody>
          {folder.children.map((child) => (
            <TableRow key={child.id}>
              <TableCell>
                <Link to={`/folders/${child.id}`}>{child.name}</Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <h2>文件</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名稱</TableHead>
            <TableHead>目前版本</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folder.documents.map((document) => (
            <TableRow key={document.id}>
              <TableCell>
                <Link to={`/documents/${document.id}`}>{document.name}</Link>
              </TableCell>
              <TableCell>
                {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
