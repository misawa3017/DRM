import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { ChevronLeft, FileText, Folder } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { listRootFolders, getFolder } from '../api/folders';

export interface PickedResource {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  // Ancestor path only (excludes the resource's own name), e.g. "Root" or
  // "Root / 財務" — mirrors the API's resolveFolderPath convention so the
  // grant form can show where a nested resource actually lives, not just
  // its bare name.
  path: string;
}

interface ResourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (resource: PickedResource) => void;
  mode?: 'any' | 'folder-only';
  title?: string;
}

export function ResourcePicker({
  open,
  onOpenChange,
  onSelect,
  mode = 'any',
  title = '選擇資源',
}: ResourcePickerProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [folderId, setFolderId] = useState<string | null>(null);
  // Breadcrumb trail from root down to (and including) the current folder,
  // built up as the user drills in via the names already at hand in the
  // list rather than re-fetching ancestors after the fact.
  const [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]);

  // The component never unmounts between opens (it's always rendered, just
  // hidden), so without this the dialog would resume wherever browsing left
  // off last time instead of starting fresh at the root each time it opens.
  useEffect(() => {
    if (open) {
      setFolderId(null);
      setCrumbs([]);
    }
  }, [open]);

  const rootQuery = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: open && folderId === null,
  });
  const folderQuery = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId ?? '', accessToken),
    enabled: open && folderId !== null,
  });
  // Derived from the live query rather than tracked as separate state, so it
  // can never drift out of sync when navigating (e.g. via "返回上一層", where
  // there's no list item at hand to read a name off of directly).
  const folderName = folderQuery.data?.name ?? '';
  // Ancestor path of the current folder (excludes its own name).
  const ancestorPath = ['Root', ...crumbs.slice(0, -1).map((c) => c.name)].join(' / ');
  // Full path including the current folder's own name, for the picker's
  // own "選擇這個資料夾" confirmation label.
  const fullPath = ['Root', ...crumbs.map((c) => c.name)].join(' / ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {folderId === null ? (
          <ul className="overflow-hidden rounded-md border">
            {(rootQuery.data ?? []).map((folder) => (
              <li key={folder.id} className="border-b last:border-0">
                <button
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                  onClick={() => {
                    setCrumbs([{ id: folder.id, name: folder.name }]);
                    setFolderId(folder.id);
                  }}
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <button
              className="mb-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="resource-picker-up"
              onClick={() => {
                setCrumbs(crumbs.slice(0, -1));
                setFolderId(folderQuery.data?.parentId ?? null);
              }}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              返回上一層
            </button>
            {folderQuery.data && (
              <Button
                variant="outline"
                size="sm"
                className="mb-3 w-full"
                data-testid="pick-current-folder"
                onClick={() => {
                  onSelect({
                    resourceType: 'folder',
                    resourceId: folderId,
                    name: folderName,
                    path: ancestorPath,
                  });
                }}
              >
                選擇這個資料夾：{fullPath}
              </Button>
            )}
            <ul className="overflow-hidden rounded-md border">
              {(folderQuery.data?.children ?? []).map((child) => (
                <li key={child.id} className="border-b last:border-0">
                  <button
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      setCrumbs([...crumbs, { id: child.id, name: child.name }]);
                      setFolderId(child.id);
                    }}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {child.name}
                  </button>
                </li>
              ))}
              {mode === 'any' &&
                (folderQuery.data?.documents ?? []).map((doc) => (
                  <li key={doc.id} className="border-b last:border-0">
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                      onClick={() =>
                        onSelect({
                          resourceType: 'document',
                          resourceId: doc.id,
                          name: doc.name,
                          path: fullPath,
                        })
                      }
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {doc.name}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
