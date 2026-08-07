import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
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
          <ul>
            {(rootQuery.data ?? []).map((folder) => (
              <li key={folder.id}>
                <button
                  onClick={() => {
                    setFolderId(folder.id);
                    setFolderName(folder.name);
                  }}
                >
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
              data-testid="pick-current-folder"
              onClick={() => {
                onSelect({ resourceType: 'folder', resourceId: folderId, name: folderName });
              }}
            >
              選擇這個資料夾
            </Button>
            <ul>
              {(folderQuery.data?.children ?? []).map((child) => (
                <li key={child.id}>
                  <button
                    onClick={() => {
                      setFolderId(child.id);
                      setFolderName(child.name);
                    }}
                  >
                    {child.name}
                  </button>
                </li>
              ))}
              {(folderQuery.data?.documents ?? []).map((doc) => (
                <li key={doc.id}>
                  <button
                    onClick={() => onSelect({ resourceType: 'document', resourceId: doc.id, name: doc.name })}
                  >
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
