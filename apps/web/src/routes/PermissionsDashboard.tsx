import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listGlobalPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';

export function PermissionsDashboard() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();

  const [includeInherited, setIncludeInherited] = useState(false);
  const [filter, setFilter] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['globalPermissions', includeInherited],
    queryFn: () => listGlobalPermissions(includeInherited, accessToken),
    enabled: !!accessToken,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });

  const handleRevoke = async (
    permissionId: string,
    resourceType: 'folder' | 'document',
    resourceId: string,
  ) => {
    setRevokeError(null);
    try {
      await revokePermission(resourceType, resourceId, permissionId, accessToken);
      invalidate();
    } catch (error) {
      setRevokeError(friendlyErrorMessage(error));
    }
  };

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const entries = query.data ?? [];
  const filtered = filter.trim()
    ? entries.filter(
        (e) =>
          e.resourceName.includes(filter) ||
          e.principal?.displayName.includes(filter) ||
          e.principal?.email.includes(filter),
      )
    : entries;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>

      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="permissions-filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜尋資源名稱或使用者..."
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="include-inherited-toggle"
          disabled={includeInherited || query.isFetching}
          onClick={() => setIncludeInherited(true)}
        >
          {includeInherited ? '已包含繼承項目' : '顯示繼承項目'}
        </Button>
      </div>

      {revokeError && (
        <p className="mb-4 text-sm text-destructive" data-testid="revoke-error">
          {revokeError}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        現有授權
      </h2>
      <div className="mb-8 overflow-hidden rounded-lg border bg-background">
        <PermissionsTable
          entries={filtered}
          showResourceColumn={true}
          onRevoke={(permissionId) => {
            const entry = entries.find((e) => e.id === permissionId);
            if (entry) handleRevoke(permissionId, entry.resourceType, entry.resourceId);
          }}
        />
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        新增授權
      </h2>
      <GrantPermissionForm onGranted={invalidate} />
    </div>
  );
}
