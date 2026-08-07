import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText } from 'lucide-react';
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
import { useSetNavbarCrumb } from '../lib/navbarBreadcrumb';

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

  const folder = query.data;
  const crumb = useMemo(
    () =>
      folder ? (
        <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
      ) : null,
    [folder],
  );
  useSetNavbarCrumb(crumb);

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;
  if (!folder) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{folder.name}</h1>
        <div className="flex gap-2">
          <CreateFolderDialog parentId={folder.id} />
          <UploadDialog mode="new-document" folderId={folder.id} />
          {folder.canManage && (
            <Link
              to={`/folders/${folder.id}/permissions`}
              className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              權限
            </Link>
          )}
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        子資料夾
      </h2>
      <div className="mb-8 overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableBody>
            {folder.children.map((child) => (
              <TableRow key={child.id}>
                <TableCell>
                  <Link to={`/folders/${child.id}`} className="flex items-center gap-2">
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    {child.name}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        文件
      </h2>
      <div className="overflow-hidden rounded-lg border bg-background">
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
                  <Link to={`/documents/${document.id}`} className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {document.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
