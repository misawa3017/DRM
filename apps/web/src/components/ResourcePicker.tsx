import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FileText, Folder } from 'lucide-react';
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
  const [folderName, setFolderName] = useState<string>('');

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
                  onClick={() => {
                    setFolderId(folder.id);
                    setFolderName(folder.name);
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
            <ul className="overflow-hidden rounded-md border">
              {(folderQuery.data?.children ?? []).map((child) => (
                <li key={child.id} className="border-b last:border-0">
                  <button
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      setFolderId(child.id);
                      setFolderName(child.name);
                    }}
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
