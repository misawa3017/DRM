import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FolderInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { moveFolder, type FolderSummary } from '../api/folders';
import { moveDocument, type DocumentDetail } from '../api/documents';
import { moveErrorMessage } from '../api/client';
import { ResourcePicker } from './ResourcePicker';

interface MoveButtonProps {
  resourceType: 'folder' | 'document';
  resourceId: string;
  onMoved: () => void;
}

export function MoveButton({ resourceType, resourceId, onMoved }: MoveButtonProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<FolderSummary | DocumentDetail, unknown, string>({
    mutationFn: (destinationId: string) =>
      resourceType === 'folder'
        ? moveFolder(resourceId, destinationId, accessToken)
        : moveDocument(resourceId, destinationId, accessToken),
    onSuccess: () => {
      setPickerOpen(false);
      onMoved();
    },
    onError: (err) => setError(moveErrorMessage(err)),
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label="移動"
        data-testid={`move-${resourceType}-${resourceId}`}
        onClick={() => {
          setError(null);
          setPickerOpen(true);
        }}
      >
        <FolderInput className="h-4 w-4" />
      </Button>
      <ResourcePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="folder-only"
        title="選擇移動目的地"
        errorMessage={error}
        onSelect={(picked) => mutation.mutate(picked.resourceId)}
      />
    </>
  );
}
