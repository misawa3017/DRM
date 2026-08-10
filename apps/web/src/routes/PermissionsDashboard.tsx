import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listGlobalPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';
import { getRolesFromToken } from '../lib/jwt';

export function PermissionsDashboard() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  // Admins already see every permission in the system regardless of this
  // toggle (the backend short-circuits findManagedResources to "all" for
  // the admin role, bypassing the direct/inherited distinction entirely),
  // so clicking it would visibly change the button but never the table —
  // confusing enough in practice to disable it outright rather than let an
  // admin click it and wonder if it's broken.
  const isAdmin = getRolesFromToken(accessToken).includes('admin');

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
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>

      <div className="mb-4 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
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
          disabled={isAdmin || includeInherited || query.isFetching}
          title={isAdmin ? 'admin 本來就看得到系統中所有的授權' : undefined}
          onClick={() => setIncludeInherited(true)}
        >
          {includeInherited ? '已包含繼承項目' : '顯示繼承項目'}
        </Button>
      </div>
      {isAdmin && (
        <p className="mb-4 text-xs text-muted-foreground">
          你是 admin，已經看得到系統中所有的授權，「顯示繼承項目」對你沒有作用。
        </p>
      )}

      {revokeError && (
        <p className="mb-4 text-sm text-destructive" data-testid="revoke-error">
          {revokeError}
        </p>
      )}

      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        現有授權
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        僅列出你可以管理的資源（即你擁有 manage 權限、能再授權給其他人的資源）。若某項資源只授予你檢視、下載或編輯權限，不會出現在這裡。
      </p>
      <div className="mb-8 overflow-x-auto rounded-lg border bg-background">
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
