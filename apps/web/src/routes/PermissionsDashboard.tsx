import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
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

  const query = useQuery({
    queryKey: ['globalPermissions', includeInherited],
    queryFn: () => listGlobalPermissions(includeInherited, accessToken),
    enabled: !!accessToken,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });

  const handleRevoke = (
    permissionId: string,
    resourceType: 'folder' | 'document',
    resourceId: string,
  ) => {
    revokePermission(resourceType, resourceId, permissionId, accessToken).then(invalidate);
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
        <input
          data-testid="permissions-filter-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜尋資源名稱或使用者..."
        />
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

      <PermissionsTable
        entries={filtered}
        showResourceColumn={true}
        onRevoke={(permissionId) => {
          const entry = entries.find((e) => e.id === permissionId);
          if (entry) handleRevoke(permissionId, entry.resourceType, entry.resourceId);
        }}
      />

      <div className="mt-6">
        <GrantPermissionForm onGranted={invalidate} />
      </div>
    </div>
  );
}
