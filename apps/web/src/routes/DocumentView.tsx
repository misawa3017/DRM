import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FileText } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { getDocument, listVersions, downloadDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { UploadDialog } from '../components/UploadDialog';

export function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';

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
            {doc.name}
          </h1>
          <div className="flex gap-2">
            <Button data-testid="download-current" onClick={() => handleDownload()}>
              下載目前版本
            </Button>
            <UploadDialog mode="new-version" documentId={documentId} />
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
      </div>

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
                  <TableCell>{version.uploadedBy}</TableCell>
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
