import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { searchUsers, type UserSummary } from '../api/users';
import { grantPermission, type PermissionLevel } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { ResourcePicker, type PickedResource } from './ResourcePicker';

const LEVEL_OPTIONS: { value: PermissionLevel; label: string; desc: string }[] = [
  { value: 'view', label: 'view', desc: '檢視' },
  { value: 'download', label: 'download', desc: '下載' },
  { value: 'edit', label: 'edit', desc: '編輯' },
  { value: 'manage', label: 'manage', desc: '管理' },
];

function initials(name: string) {
  return name.slice(0, 1);
}

interface FixedResource {
  resourceType: 'folder' | 'document';
  resourceId: string;
}

interface GrantPermissionFormProps {
  fixedResource?: FixedResource;
  onGranted: () => void;
}

export function GrantPermissionForm({ fixedResource, onGranted }: GrantPermissionFormProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedResource, setPickedResource] = useState<PickedResource | null>(null);
  const resource: FixedResource | null =
    fixedResource ??
    (pickedResource
      ? { resourceType: pickedResource.resourceType, resourceId: pickedResource.resourceId }
      : null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [level, setLevel] = useState<PermissionLevel>('view');

  const searchResults = useQuery({
    queryKey: ['userSearch', searchQuery],
    queryFn: () => searchUsers(searchQuery, accessToken),
    enabled: searchQuery.trim() !== '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (!resource || !selectedUser) throw new Error('resource and user must be selected');
      return grantPermission(
        resource.resourceType,
        resource.resourceId,
        { principalId: selectedUser.id, permissionLevel: level },
        accessToken,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });
      setSelectedUser(null);
      setSearchInput('');
      setSearchQuery('');
      onGranted();
    },
  });

  return (
    <div className="rounded-lg border bg-background p-5">
      <h3 className="text-sm font-bold">授權存取權限</h3>
      <p className="mb-4 text-xs text-muted-foreground">搜尋使用者，選擇要授予的權限層級</p>

      {!fixedResource && (
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">資源</label>
          <div
            className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
              pickedResource ? 'border-primary/40' : 'border-dashed'
            }`}
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={`text-sm ${pickedResource ? 'font-medium' : 'text-muted-foreground'}`}>
              {pickedResource ? pickedResource.name : '尚未選擇資源'}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              data-testid="open-resource-picker"
              onClick={() => setPickerOpen(true)}
            >
              {pickedResource ? '重新選擇' : '選擇資源'}
            </Button>
          </div>
          <ResourcePicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={(r) => {
              setPickedResource(r);
              setPickerOpen(false);
            }}
          />
        </div>
      )}

      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">使用者</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              data-testid="user-search-input"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="輸入姓名或 email"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="user-search-submit"
            onClick={() => setSearchQuery(searchInput)}
          >
            搜尋
          </Button>
        </div>

        {!selectedUser && searchResults.isError && (
          <p className="mt-2 text-sm text-destructive">{friendlyErrorMessage(searchResults.error)}</p>
        )}
        {!selectedUser && searchResults.data && searchResults.data.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="no-results">
            找不到符合的使用者
          </p>
        )}
        {!selectedUser && searchResults.data && searchResults.data.length > 0 && (
          <ul className="mt-2 overflow-hidden rounded-md border">
            {searchResults.data.map((user) => (
              <li key={user.id} className="border-b last:border-0">
                <button
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => {
                    setSelectedUser(user);
                    setSearchInput('');
                    setSearchQuery('');
                  }}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    {initials(user.displayName)}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{user.displayName}</span>
                    <span className="block text-xs text-muted-foreground">{user.email}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedUser && (
          <div className="mt-2 flex items-center gap-2.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {initials(selectedUser.displayName)}
            </span>
            <span>
              <span className="block text-sm font-medium">{selectedUser.displayName}</span>
              <span className="block text-xs text-muted-foreground">{selectedUser.email}</span>
            </span>
            <button
              className="ml-auto text-muted-foreground hover:text-foreground"
              aria-label="清除已選擇的使用者"
              onClick={() => setSelectedUser(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <div className="mb-5">
        <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">權限層級</label>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="權限層級">
          {LEVEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={level === opt.value}
              data-testid={`permission-level-${opt.value}`}
              onClick={() => setLevel(opt.value)}
              className={`rounded-md border px-2 py-2 text-center ${
                level === opt.value
                  ? 'border-primary bg-primary/5'
                  : 'border-input hover:bg-muted/50'
              }`}
            >
              <span
                className={`block text-xs font-bold ${level === opt.value ? 'text-primary' : ''}`}
              >
                {opt.label}
              </span>
              <span className="block text-[10px] text-muted-foreground">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {mutation.isError && (
        <p className="mb-3 text-sm text-destructive">{friendlyErrorMessage(mutation.error)}</p>
      )}

      <div className="flex justify-end">
        <Button
          data-testid="grant-submit"
          disabled={!resource || !selectedUser || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          授權
        </Button>
      </div>
    </div>
  );
}
