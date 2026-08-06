import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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

  const handleDownload = async (versionId?: string) => {
    const { blob, fileName } = await downloadDocument(documentId, versionId, accessToken);
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (documentQuery.isLoading) return <p data-testid="loading">Loading...</p>;
  if (documentQuery.isError) {
    return <p data-testid="error">{friendlyErrorMessage(documentQuery.error)}</p>;
  }

  const doc = documentQuery.data!;

  return (
    <div>
      <h1>{doc.name}</h1>
      <Button data-testid="download-current" onClick={() => handleDownload()}>
        下載目前版本
      </Button>
      <UploadDialog mode="new-version" documentId={documentId} />

      <h2>版本歷史</h2>
      {versionsQuery.isLoading && <p data-testid="versions-loading">Loading versions...</p>}
      {versionsQuery.isError && (
        <p data-testid="versions-error">{friendlyErrorMessage(versionsQuery.error)}</p>
      )}
      {versionsQuery.data && (
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
      )}
    </div>
  );
}
