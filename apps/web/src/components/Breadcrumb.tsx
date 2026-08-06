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
    <nav aria-label="breadcrumb" className="flex items-center gap-1 text-primary-foreground/80">
      <Link to="/" className="hover:text-primary-foreground hover:underline">
        Root
      </Link>
      {ancestors.data?.map((crumb) => (
        <span key={crumb.id} className="flex items-center gap-1">
          <span className="opacity-60">/</span>
          <Link
            to={`/folders/${crumb.id}`}
            className="hover:text-primary-foreground hover:underline"
          >
            {crumb.name}
          </Link>
        </span>
      ))}
      <span className="opacity-60">/</span>
      <span key={currentId} className="font-medium text-primary-foreground">
        {currentName}
      </span>
    </nav>
  );
}
