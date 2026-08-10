import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText } from 'lucide-react';
import { searchResources } from '../api/search';
import { friendlyErrorMessage } from '../api/client';

export function Search() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';

  const searchQuery = useQuery({
    queryKey: ['search', query],
    queryFn: () => searchResources(query, accessToken),
    enabled: !!query.trim() && !!accessToken,
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-6 break-words text-xl font-bold">搜尋{query ? `：${query}` : ''}</h1>

      {!query.trim() && <p className="text-muted-foreground">請輸入關鍵字搜尋</p>}

      {query.trim() && searchQuery.isLoading && (
        <p data-testid="loading">Loading...</p>
      )}
      {query.trim() && searchQuery.isError && (
        <p data-testid="error">{friendlyErrorMessage(searchQuery.error)}</p>
      )}
      {query.trim() && searchQuery.data && searchQuery.data.length === 0 && (
        <p className="text-muted-foreground">找不到符合的項目</p>
      )}
      {query.trim() && searchQuery.data && searchQuery.data.length > 0 && (
        <ul className="overflow-hidden rounded-lg border bg-background">
          {searchQuery.data.map((item) => (
            <li key={`${item.resourceType}-${item.resourceId}`} className="border-b last:border-0">
              <Link
                to={
                  item.resourceType === 'folder'
                    ? `/folders/${item.resourceId}`
                    : `/documents/${item.resourceId}`
                }
                className="flex items-center gap-2.5 px-4 py-3 hover:bg-muted/50"
              >
                {item.resourceType === 'folder' ? (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium">{item.name}</span>
                  <span className="block break-all text-xs text-muted-foreground">{item.path}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
