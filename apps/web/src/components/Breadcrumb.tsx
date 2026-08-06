import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { getFolder } from '../api/folders';

interface Crumb {
  id: string;
  name: string;
}

function useAncestors(parentId: string | null, accessToken: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['ancestors', parentId],
    queryFn: async () => {
      const chain: Crumb[] = [];
      let currentParentId = parentId;
      while (currentParentId) {
        const id = currentParentId;
        const folder = await queryClient.fetchQuery({
          queryKey: ['folder', id],
          queryFn: () => getFolder(id, accessToken),
        });
        chain.unshift({ id: folder.id, name: folder.name });
        currentParentId = folder.parentId;
      }
      return chain;
    },
  });
}

interface BreadcrumbProps {
  currentId: string;
  currentName: string;
  parentId: string | null;
}

export function Breadcrumb({ currentId, currentName, parentId }: BreadcrumbProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const ancestors = useAncestors(parentId, accessToken);

  return (
    <nav aria-label="breadcrumb">
      <Link to="/">Root</Link>
      {ancestors.data?.map((crumb) => (
        <span key={crumb.id}>
          {' / '}
          <Link to={`/folders/${crumb.id}`}>{crumb.name}</Link>
        </span>
      ))}
      {' / '}
      <span key={currentId}>{currentName}</span>
    </nav>
  );
}
