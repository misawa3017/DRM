import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { previewDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { Button } from './ui/button';

function PdfFrame({ blob }: { blob: Blob }) {
  const [url] = useState(() => URL.createObjectURL(blob));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return (
    <iframe
      title="受保護的 PDF 預覽"
      src={`${url}#toolbar=0&navpanes=0`}
      className="h-[70vh] min-h-[520px] w-full bg-muted"
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

export function ProtectedPdfPreview({
  documentId,
  accessToken,
}: {
  documentId: string;
  accessToken: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ['documentPreview', documentId],
    queryFn: () => previewDocument(documentId, accessToken),
    enabled: open && !!accessToken,
    retry: false,
  });

  return (
    <section className="mb-8 overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">站內預覽</h2>
          <p className="text-xs text-muted-foreground">預覽內容由伺服器即時套用 DRM 浮水印</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
          {open ? '關閉預覽' : '開啟預覽'}
        </Button>
      </div>
      {open && preview.isLoading && <p className="p-5" data-testid="preview-loading">載入預覽中...</p>}
      {open && preview.isError && (
        <p className="p-5 text-sm text-destructive" data-testid="preview-error">
          {friendlyErrorMessage(preview.error)}
        </p>
      )}
      {open && preview.data && <PdfFrame key={preview.data.size} blob={preview.data} />}
    </section>
  );
}
