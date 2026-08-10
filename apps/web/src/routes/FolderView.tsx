import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  getFolder,
  renameFolder,
  deleteFolder,
  updateFolderWatermark,
  type FolderChildSummary,
  type DocumentChildSummary,
} from '../api/folders';
import { renameDocument, deleteDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';
import { InlineEditableName } from '../components/InlineEditableName';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { MoveButton } from '../components/MoveButton';
import { useSetNavbarCrumb } from '../lib/navbarBreadcrumb';
import { WatermarkSetting } from '../components/WatermarkSetting';

function FolderRow({
  folder,
  onChanged,
}: {
  folder: FolderChildSummary;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameFolder(folder.id, name, accessToken),
    onSuccess: onChanged,
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteFolder(folder.id, accessToken),
    onSuccess: () => {
      setConfirmOpen(false);
      onChanged();
    },
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Link to={`/folders/${folder.id}`} className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-muted-foreground" />
          </Link>
          {folder.canEdit ? (
            <InlineEditableName
              value={folder.name}
              onSave={(name) => renameMutation.mutate(name)}
              ariaLabel="編輯資料夾名稱"
              testId={`folder-row-name-${folder.id}`}
            />
          ) : (
            <Link to={`/folders/${folder.id}`}>{folder.name}</Link>
          )}
        </div>
        {rowError && (
          <p className="mt-1 text-xs text-destructive" data-testid={`folder-row-error-${folder.id}`}>
            {rowError}
          </p>
        )}
      </TableCell>
      <TableCell className="w-0 whitespace-nowrap">
        {folder.canEdit && (
          <div className="flex items-center gap-1">
            <MoveButton resourceType="folder" resourceId={folder.id} onMoved={onChanged} />
            <Button
              variant="outline"
              size="sm"
              aria-label="刪除"
              data-testid={`delete-folder-${folder.id}`}
              onClick={() => {
                setRowError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <DeleteConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              resourceName={folder.name}
              isDeleting={deleteMutation.isPending}
              error={rowError}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function DocumentRow({
  document,
  onChanged,
}: {
  document: DocumentChildSummary;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameDocument(document.id, name, accessToken),
    onSuccess: onChanged,
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDocument(document.id, accessToken),
    onSuccess: () => {
      setConfirmOpen(false);
      onChanged();
    },
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Link to={`/documents/${document.id}`} className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
          </Link>
          {document.canEdit ? (
            <InlineEditableName
              value={document.name}
              onSave={(name) => renameMutation.mutate(name)}
              ariaLabel="編輯文件名稱"
              testId={`document-row-name-${document.id}`}
            />
          ) : (
            <Link to={`/documents/${document.id}`}>{document.name}</Link>
          )}
        </div>
        {rowError && (
          <p
            className="mt-1 text-xs text-destructive"
            data-testid={`document-row-error-${document.id}`}
          >
            {rowError}
          </p>
        )}
      </TableCell>
      <TableCell>
        {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
      </TableCell>
      <TableCell className="w-0 whitespace-nowrap">
        {document.canEdit && (
          <div className="flex items-center gap-1">
            <MoveButton resourceType="document" resourceId={document.id} onMoved={onChanged} />
            <Button
              variant="outline"
              size="sm"
              aria-label="刪除"
              data-testid={`delete-document-${document.id}`}
              onClick={() => {
                setRowError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <DeleteConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              resourceName={document.name}
              isDeleting={deleteMutation.isPending}
              error={rowError}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function FolderView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId, accessToken),
    enabled: !!folderId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['folder'] });
    queryClient.invalidateQueries({ queryKey: ['rootFolders'] });
  };

  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerDeleteOpen, setHeaderDeleteOpen] = useState(false);

  const folder = query.data;
  const crumb = useMemo(
    () =>
      folder ? (
        <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
      ) : null,
    [folder],
  );
  useSetNavbarCrumb(crumb);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameFolder(folderId, name, accessToken),
    onSuccess: invalidate,
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteFolder(folderId, accessToken),
    onSuccess: () => {
      invalidate();
      navigate(folder?.parentId ? `/folders/${folder.parentId}` : '/');
    },
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });
  const watermarkMutation = useMutation({
    mutationFn: (value: boolean | null) =>
      updateFolderWatermark(folderId, value, accessToken),
    onSuccess: invalidate,
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;
  if (!folder) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        {folder.canEdit ? (
          <InlineEditableName
            value={folder.name}
            onSave={(name) => renameMutation.mutate(name)}
            className="text-xl font-bold"
            ariaLabel="編輯資料夾名稱"
            testId="folder-name"
          />
        ) : (
          <h1 className="text-xl font-bold">{folder.name}</h1>
        )}
        <div className="flex gap-2">
          {folder.canEdit && (
            <>
              <CreateFolderDialog parentId={folder.id} />
              <UploadDialog mode="new-document" folderId={folder.id} />
            </>
          )}
          {folder.canEdit && folder.parentId && (
            <MoveButton resourceType="folder" resourceId={folder.id} onMoved={invalidate} />
          )}
          {folder.canEdit && (
            <>
              <Button
                variant="outline"
                size="sm"
                aria-label="刪除"
                data-testid={`delete-folder-${folder.id}`}
                onClick={() => {
                  setHeaderError(null);
                  setHeaderDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <DeleteConfirmDialog
                open={headerDeleteOpen}
                onOpenChange={setHeaderDeleteOpen}
                resourceName={folder.name}
                isDeleting={deleteMutation.isPending}
                error={headerError}
                onConfirm={() => deleteMutation.mutate()}
              />
            </>
          )}
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
      {headerError && (
        <p className="mb-4 text-sm text-destructive" data-testid="folder-header-error">
          {headerError}
        </p>
      )}

      {folder.canManage && (
        <section className="mb-8 rounded-lg border bg-background p-5" data-testid="folder-policy-settings">
          <h2 className="mb-1 font-semibold">DRM 保護設定</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            子資料夾與文件若選擇繼承，會沿用這裡的浮水印設定
          </p>
          <WatermarkSetting
            value={folder.watermarkEnabled}
            disabled={watermarkMutation.isPending}
            onChange={(value) => {
              setHeaderError(null);
              watermarkMutation.mutate(value);
            }}
          />
        </section>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        子資料夾
      </h2>
      <div className="mb-8 overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableBody>
            {folder.children.map((child) => (
              <FolderRow key={child.id} folder={child} onChanged={invalidate} />
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
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {folder.documents.map((document) => (
              <DocumentRow key={document.id} document={document} onChanged={invalidate} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
