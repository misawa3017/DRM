import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { downloadSharedDocument, listReceivedShares } from '../api/shares';
import { friendlyErrorMessage } from '../api/client';

export function ReceivedShares() {
  const auth = useAuth();
  const navigate = useNavigate();
  const accessToken = auth.user?.access_token ?? '';
  const query = useQuery({ queryKey: ['receivedShares'], queryFn: () => listReceivedShares(accessToken) });
  const download = useMutation({ mutationFn: (shareId: string) => downloadSharedDocument(shareId, accessToken) });

  if (query.isLoading) return <p className="p-6">載入分享中...</p>;
  if (query.isError) return <p className="p-6 text-destructive">{friendlyErrorMessage(query.error)}</p>;
  return <main className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
    <h1 className="text-xl font-bold">收到的限時分享</h1>
    <p className="mt-1 text-sm text-muted-foreground">到期後將立即無法下載、預覽或編輯。</p>
    <div className="mt-6 space-y-3">
      {(query.data ?? []).map((share) => <section key={share.id} className="rounded-lg border p-4">
        <div className="font-medium">{share.document.name}</div>
        <div className="mt-1 text-sm text-muted-foreground">{share.accessLevel === 'edit' ? '可編輯' : '唯讀'}・到期：{new Date(share.expiresAt).toLocaleString('zh-TW')}・{share.maskRules?.length ? '已套用個資遮蔽' : '未遮蔽'}</div>
        <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => download.mutate(share.id)}>下載</Button>{share.accessLevel === 'edit' && <Button size="sm" variant="outline" onClick={() => navigate(`/shares/${share.id}/edit`)}>開啟線上編輯</Button>}</div>
      </section>)}
      {query.data?.length === 0 && <p className="text-muted-foreground">目前沒有有效的分享。</p>}
    </div>
    {download.isError && <p className="mt-3 text-sm text-destructive">{friendlyErrorMessage(download.error)}</p>}
  </main>;
}
