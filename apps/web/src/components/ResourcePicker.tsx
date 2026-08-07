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
}

interface ResourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (resource: PickedResource) => void;
}

export function ResourcePicker({ open, onOpenChange, onSelect }: ResourcePickerProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [folderId, setFolderId] = useState<string | null>(null);

  // The component never unmounts between opens (it's always rendered, just
  // hidden), so without this the dialog would resume wherever browsing left
  // off last time instead of starting fresh at the root each time it opens.
  useEffect(() => {
    if (open) {
      setFolderId(null);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>選擇資源</DialogTitle>
        </DialogHeader>

        {folderId === null ? (
          <ul className="overflow-hidden rounded-md border">
            {(rootQuery.data ?? []).map((folder) => (
              <li key={folder.id} className="border-b last:border-0">
                <button
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                  onClick={() => setFolderId(folder.id)}
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
              onClick={() => setFolderId(folderQuery.data?.parentId ?? null)}
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
                  onSelect({ resourceType: 'folder', resourceId: folderId, name: folderName });
                }}
              >
                選擇這個資料夾：{folderName}
              </Button>
            )}
            <ul className="overflow-hidden rounded-md border">
              {(folderQuery.data?.children ?? []).map((child) => (
                <li key={child.id} className="border-b last:border-0">
                  <button
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => setFolderId(child.id)}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {child.name}
                  </button>
                </li>
              ))}
              {(folderQuery.data?.documents ?? []).map((doc) => (
                <li key={doc.id} className="border-b last:border-0">
                  <button
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => onSelect({ resourceType: 'document', resourceId: doc.id, name: doc.name })}
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
