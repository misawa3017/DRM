import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { CalendarClock, FileText, ShieldCheck, Trash2 } from 'lucide-react';
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
  getDocument,
  listVersions,
  downloadDocument,
  renameDocument,
  deleteDocument,
  updateDocumentExpiration,
  updateDocumentWatermark,
  type DocumentDetail,
} from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { UploadDialog } from '../components/UploadDialog';
import { InlineEditableName } from '../components/InlineEditableName';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { MoveButton } from '../components/MoveButton';
import { WatermarkSetting } from '../components/WatermarkSetting';
import { ProtectedPdfPreview } from '../components/ProtectedPdfPreview';

const PREVIEWABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function DocumentPolicySettings({
  doc,
  accessToken,
  onChanged,
}: {
  doc: DocumentDetail;
  accessToken: string;
  onChanged: () => void;
}) {
  const [expiresAt, setExpiresAt] = useState(() => toLocalDateTime(doc.expiresAt));
  const [error, setError] = useState<string | null>(null);
  const watermarkMutation = useMutation({
    mutationFn: (value: boolean | null) =>
      updateDocumentWatermark(doc.id, value, accessToken),
    onSuccess: onChanged,
    onError: (err) => setError(friendlyErrorMessage(err)),
  });
  const watermarkTemplateMutation = useMutation({
    mutationFn: (template: string | null) =>
      updateDocumentWatermark(doc.id, doc.watermarkEnabled ?? null, accessToken, template),
    onSuccess: onChanged,
    onError: (err) => setError(friendlyErrorMessage(err)),
  });
  const expirationMutation = useMutation({
    mutationFn: () =>
      updateDocumentExpiration(
        doc.id,
        expiresAt ? new Date(expiresAt).toISOString() : null,
        accessToken,
      ),
    onSuccess: onChanged,
    onError: (err) => setError(friendlyErrorMessage(err)),
  });

  return (
    <section className="mb-8 rounded-lg border bg-background p-5" data-testid="document-policy-settings">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-semibold">DRM 保護設定</h2>
          <p className="text-xs text-muted-foreground">只有具管理權限的使用者可以變更</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <WatermarkSetting
          value={doc.watermarkEnabled}
          template={doc.watermarkTemplate}
          disabled={watermarkMutation.isPending || watermarkTemplateMutation.isPending}
          onChange={(value) => {
            setError(null);
            watermarkMutation.mutate(value);
          }}
          onTemplateChange={(template) => {
            setError(null);
            watermarkTemplateMutation.mutate(template);
          }}
        />
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">到期時間</span>
          <div className="flex gap-2">
            <input
              aria-label="到期時間"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3"
            />
            <Button
              size="sm"
              disabled={expirationMutation.isPending}
              onClick={() => {
                setError(null);
                expirationMutation.mutate();
              }}
            >
              儲存
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">留空代表永不到期</span>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm">
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
        狀態：{doc.status === 'expired' ? '已到期' : '使用中'}
      </div>
      {error && <p className="mt-3 text-sm text-destructive" data-testid="policy-error">{error}</p>}
    </section>
  );
}

export function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => getDocument(documentId, accessToken),
    enabled: !!documentId,
  });
  const versionsQuery = useQuery({
    queryKey: ['documentVersions', documentId],
    queryFn: () => listVersions(documentId, accessToken),
    enabled: !!documentId,
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['document'] });
    queryClient.invalidateQueries({ queryKey: ['folder'] });
  };
  const invalidateDocument = () => {
    queryClient.invalidateQueries({ queryKey: ['document', documentId] });
  };

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameDocument(documentId, name, accessToken),
    onSuccess: invalidate,
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDocument(documentId, accessToken),
    onSuccess: () => {
      invalidate();
      if (documentQuery.data) {
        navigate(`/folders/${documentQuery.data.folderId}`);
      }
    },
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });

  const handleDownload = async (versionId?: string) => {
    setDownloadError(null);
    try {
      const { blob, fileName } = await downloadDocument(documentId, versionId, accessToken);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(friendlyErrorMessage(error));
    }
  };

  if (documentQuery.isLoading) return <p data-testid="loading">Loading...</p>;
  if (documentQuery.isError) {
    return <p data-testid="error">{friendlyErrorMessage(documentQuery.error)}</p>;
  }

  const doc = documentQuery.data;
  if (!doc) return <p data-testid="loading">Loading...</p>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="h-5 w-5 text-muted-foreground" />
            {doc.canEdit ? (
              <InlineEditableName
                value={doc.name}
                onSave={(name) => renameMutation.mutate(name)}
                ariaLabel="編輯文件名稱"
                testId="document-name"
              />
            ) : (
              doc.name
            )}
          </h1>
          <div className="flex gap-2">
            <Button data-testid="download-current" onClick={() => handleDownload()}>
              下載目前版本
            </Button>
            <UploadDialog mode="new-version" documentId={documentId} />
            {doc.canEdit && (
              <>
                <MoveButton resourceType="document" resourceId={documentId} onMoved={invalidate} />
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="刪除"
                  data-testid={`delete-document-${documentId}`}
                  onClick={() => {
                    setHeaderError(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <DeleteConfirmDialog
                  open={deleteOpen}
                  onOpenChange={setDeleteOpen}
                  resourceName={doc.name}
                  isDeleting={deleteMutation.isPending}
                  error={headerError}
                  onConfirm={() => deleteMutation.mutate()}
                />
              </>
            )}
            {doc.canManage && (
              <Link
                to={`/documents/${documentId}/permissions`}
                className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
              >
                權限
              </Link>
            )}
          </div>
        </div>
        {downloadError && (
          <p className="px-5 py-3 text-sm text-destructive" data-testid="download-error">
            {downloadError}
          </p>
        )}
        {headerError && (
          <p className="px-5 py-3 text-sm text-destructive" data-testid="document-header-error">
            {headerError}
          </p>
        )}
      </div>

      {doc.canManage && (
        <DocumentPolicySettings
          key={`${doc.watermarkEnabled}-${doc.expiresAt}-${doc.status}`}
          doc={doc}
          accessToken={accessToken}
          onChanged={invalidateDocument}
        />
      )}

      {doc.currentVersion && PREVIEWABLE_MIME_TYPES.has(doc.currentVersion.mimeType) && (
        <ProtectedPdfPreview documentId={documentId} accessToken={accessToken} />
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        版本歷史
      </h2>
      {versionsQuery.isLoading && <p data-testid="versions-loading">Loading versions...</p>}
      {versionsQuery.isError && (
        <p data-testid="versions-error">{friendlyErrorMessage(versionsQuery.error)}</p>
      )}
      {versionsQuery.data && (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>大小（bytes）</TableHead>
                <TableHead>上傳者</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versionsQuery.data.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>v{version.versionNumber}</TableCell>
                  <TableCell>{version.sizeBytes}</TableCell>
                  <TableCell>
                    <span className="block font-medium">
                      {version.uploader?.displayName || version.uploader?.email || version.uploadedBy}
                    </span>
                    {version.uploader?.displayName && (
                      <span className="block text-xs text-muted-foreground">
                        {version.uploader.email}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      data-testid={`download-version-${version.id}`}
                      onClick={() => handleDownload(version.id)}
                    >
                      下載此版本
                    </Button>
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
