import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { getShareEditorConfig } from '../api/shares';
import { friendlyErrorMessage } from '../api/client';

declare global { interface Window { DocsAPI?: { DocEditor: new (elementId: string, config: Record<string, unknown>) => unknown } } }

export function ShareEditor() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const accessToken = auth.user?.access_token ?? '';
    let script: HTMLScriptElement | null = null;
    void getShareEditorConfig(id, accessToken).then(({ documentServerUrl, config }) => {
      script = document.createElement('script');
      script.src = `${documentServerUrl}/web-apps/apps/api/documents/api.js`;
      script.onload = () => {
        if (window.DocsAPI) new window.DocsAPI.DocEditor('onlyoffice-editor', config);
        else setError('OnlyOffice 編輯器未能載入');
      };
      script.onerror = () => setError('無法連線至 OnlyOffice 文件服務');
      document.head.appendChild(script);
    }).catch((reason: unknown) => setError(friendlyErrorMessage(reason)));
    return () => script?.remove();
  }, [auth.user?.access_token, id]);
  if (error) return <p className="p-6 text-destructive">{error}</p>;
  return <main className="h-[calc(100vh-5rem)] p-3"><div id="onlyoffice-editor" className="h-full w-full" /></main>;
}
