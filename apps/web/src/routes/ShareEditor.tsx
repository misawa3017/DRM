import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getShareEditorConfig } from '../api/shares';
import { friendlyErrorMessage } from '../api/client';

interface OnlyOfficeEditor {
  destroyEditor?: () => void;
}

interface OnlyOfficeEvent {
  data?: { errorCode?: number; errorDescription?: string; warningCode?: number; warningDescription?: string };
}

declare global { interface Window { DocsAPI?: { DocEditor: new (elementId: string, config: Record<string, unknown>) => OnlyOfficeEditor } } }

export function ShareEditor() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const editor = useRef<OnlyOfficeEditor | null>(null);

  const closeEditor = () => {
    editor.current?.destroyEditor?.();
    editor.current = null;
    document.getElementById('onlyoffice-editor')?.replaceChildren();
  };

  useEffect(() => {
    const accessToken = auth.user?.access_token ?? '';
    let script: HTMLScriptElement | null = null;
    let disposed = false;
    document.querySelectorAll('script[data-onlyoffice-api]').forEach((element) => element.remove());
    void getShareEditorConfig(id, accessToken).then(({ documentServerUrl, config }) => {
      if (disposed) return;
      script = document.createElement('script');
      script.dataset.onlyofficeApi = 'true';
      script.src = `${documentServerUrl}/web-apps/apps/api/documents/api.js?v=${Date.now()}`;
      script.onload = () => {
        if (disposed) return;
        const runtimeConfig = {
          ...config,
          events: {
            onError: (event: OnlyOfficeEvent) => {
              const code = event.data?.errorCode ?? 'unknown';
              const description = event.data?.errorDescription ?? JSON.stringify(event.data ?? {});
              setDiagnostic(`OnlyOffice error ${code}: ${description}`);
            },
            onWarning: (event: OnlyOfficeEvent) => {
              const code = event.data?.warningCode ?? 'unknown';
              const description = event.data?.warningDescription ?? JSON.stringify(event.data ?? {});
              setDiagnostic(`OnlyOffice warning ${code}: ${description}`);
            },
          },
        };
        if (window.DocsAPI) editor.current = new window.DocsAPI.DocEditor('onlyoffice-editor', runtimeConfig);
        else setError('OnlyOffice 編輯器未能載入');
      };
      script.onerror = () => setError('無法連線至 OnlyOffice 文件服務');
      document.head.appendChild(script);
    }).catch((reason: unknown) => setError(friendlyErrorMessage(reason)));
    return () => {
      disposed = true;
      closeEditor();
      script?.remove();
      delete window.DocsAPI;
    };
  }, [auth.user?.access_token, id]);
  if (error) return <p className="p-6 text-destructive">{error}</p>;
  return <main className="flex h-[calc(100vh-5rem)] flex-col gap-3 p-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">離開後 OnlyOffice 會結束編輯工作階段；請先等候右上角顯示儲存完成。</p>
      <Button type="button" variant="outline" onClick={() => { closeEditor(); navigate('/shares'); }}>
        <ArrowLeft className="mr-1 h-4 w-4" />結束編輯並返回我的分享
      </Button>
    </div>
    {diagnostic && <p className="rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">{diagnostic}</p>}
    <div id="onlyoffice-editor" className="min-h-0 flex-1 w-full" />
  </main>;
}
