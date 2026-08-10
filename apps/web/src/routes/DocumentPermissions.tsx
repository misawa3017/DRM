import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { listPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';

export function DocumentPermissions() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['permissions', 'document', documentId],
    queryFn: () => listPermissions('document', documentId, accessToken),
    enabled: !!documentId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['permissions', 'document', documentId] });

  const handleRevoke = (permissionId: string) => {
    revokePermission('document', documentId, permissionId, accessToken).then(invalidate);
  };

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        現有授權
      </h2>
      <div className="mb-8 overflow-x-auto rounded-lg border bg-background">
        <PermissionsTable entries={query.data ?? []} showResourceColumn={false} onRevoke={handleRevoke} />
      </div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        新增授權
      </h2>
      <GrantPermissionForm
        fixedResource={{ resourceType: 'document', resourceId: documentId }}
        onGranted={invalidate}
      />
    </div>
  );
}
