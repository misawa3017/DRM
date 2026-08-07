import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import { searchUsers, type UserSummary } from '../api/users';
import { grantPermission, type PermissionLevel } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { ResourcePicker, type PickedResource } from './ResourcePicker';

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
    <div>
      {!fixedResource && (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="open-resource-picker"
            onClick={() => setPickerOpen(true)}
          >
            {pickedResource ? pickedResource.name : '選擇資源'}
          </Button>
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

      <div>
        <input
          data-testid="user-search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="輸入姓名或 email 搜尋使用者"
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="user-search-submit"
          onClick={() => setSearchQuery(searchInput)}
        >
          搜尋
        </Button>
      </div>

      {searchResults.isError && <p>{friendlyErrorMessage(searchResults.error)}</p>}
      {searchResults.data && searchResults.data.length === 0 && (
        <p data-testid="no-results">找不到符合的使用者</p>
      )}
      {searchResults.data && searchResults.data.length > 0 && (
        <ul>
          {searchResults.data.map((user) => (
            <li key={user.id}>
              <button onClick={() => setSelectedUser(user)}>
                <span>{user.displayName}</span>（{user.email}）
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedUser && <p>已選擇：{selectedUser.displayName}</p>}

      <select
        data-testid="permission-level-select"
        value={level}
        onChange={(e) => setLevel(e.target.value as PermissionLevel)}
      >
        <option value="view">view（檢視）</option>
        <option value="download">download（下載）</option>
        <option value="edit">edit（編輯）</option>
        <option value="manage">manage（管理）</option>
      </select>

      {mutation.isError && <p>{friendlyErrorMessage(mutation.error)}</p>}

      <Button
        data-testid="grant-submit"
        disabled={!resource || !selectedUser || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        授權
      </Button>
    </div>
  );
}
