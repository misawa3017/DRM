import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ShieldOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, friendlyErrorMessage } from '../api/client';
import {
  createDocumentShare,
  listDocumentShares,
  revokeDocumentShare,
  updateDocumentShare,
  type MaskMode,
  type MaskRule,
  type ShareAccessLevel,
} from '../api/shares';
import { searchUsers, type UserSummary } from '../api/users';

interface DocumentShareManagerProps {
  documentId: string;
  mimeType: string | undefined;
  accessToken: string;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-TW');
}

function shareErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.message.startsWith('Worksheet not found:')) return `找不到工作表「${error.message.slice('Worksheet not found:'.length).trim()}」。請填寫 Excel 分頁的完整名稱。`;
    if (error.message.startsWith('Column header not found:')) return `找不到欄位「${error.message.slice('Column header not found:'.length).trim()}」。欄位名稱必須與 Excel 第一列完全一致。`;
    if (error.message.includes('Recipient already has document access')) return '收件者原本已具備這份文件的存取權限；請先到「權限」撤銷該權限，才能建立遮蔽分享。';
    if (error.message.includes('Timed sharing is currently supported')) return '限時分享目前僅支援 .xlsx Excel 檔案。';
  }
  return friendlyErrorMessage(error);
}

export function DocumentShareManager({ documentId, mimeType, accessToken }: DocumentShareManagerProps) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [recipient, setRecipient] = useState<UserSummary | null>(null);
  const [accessLevel, setAccessLevel] = useState<ShareAccessLevel>('view');
  const [durationHours, setDurationHours] = useState('24');
  const [rules, setRules] = useState<MaskRule[]>([]);
  const [ruleSheet, setRuleSheet] = useState('');
  const [ruleHeader, setRuleHeader] = useState('');
  const [ruleMode, setRuleMode] = useState<MaskMode>('redact');
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: ['documentShares', documentId],
    queryFn: () => listDocumentShares(documentId, accessToken),
    enabled: open,
  });
  const users = useQuery({
    queryKey: ['shareUserSearch', searchQuery],
    queryFn: () => searchUsers(searchQuery, accessToken),
    enabled: searchQuery.trim().length > 0,
  });
  const resetForm = () => {
    setSearchInput('');
    setSearchQuery('');
    setRecipient(null);
    setAccessLevel('view');
    setDurationHours('24');
    setRules([]);
    setRuleSheet('');
    setRuleHeader('');
    setRuleMode('redact');
  };
  const create = useMutation({
    mutationFn: () => {
      const duration = Number(durationHours);
      if (!recipient || !Number.isInteger(duration) || duration < 1 || duration > 720) {
        throw new Error('請選擇收件者，並輸入 1 到 720 小時的有效期限');
      }
      return createDocumentShare(documentId, {
        recipientId: recipient.id,
        accessLevel,
        durationHours: duration,
        ...(rules.length > 0 ? { maskRules: rules } : {}),
      }, accessToken);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documentShares', documentId] });
      resetForm();
    },
  });
  const revoke = useMutation({
    mutationFn: (shareId: string) => revokeDocumentShare(shareId, accessToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['documentShares', documentId] }),
  });
  const extend = useMutation({
    mutationFn: (shareId: string) => updateDocumentShare(shareId, { durationHours: 24 }, accessToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['documentShares', documentId] }),
  });
  const isXlsx = mimeType === XLSX_MIME;
  const addRule = () => {
    if (!ruleSheet.trim() || !ruleHeader.trim()) return;
    setRules((current) => [...current, { sheetName: ruleSheet.trim(), header: ruleHeader.trim(), mode: ruleMode }]);
    setRuleHeader('');
  };

  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>限時分享</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>限時 Excel 分享</DialogTitle></DialogHeader>
        {!isXlsx ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            限時分享目前僅支援 .xlsx Excel 檔案。
          </p>
        ) : <>
          <p className="text-sm text-muted-foreground">分享只對公司帳號有效；到期或撤銷後會立即禁止下載與線上編輯。</p>
          <section className="grid gap-4 rounded-lg border p-4">
            <h3 className="font-medium">建立分享</h3>
            <label className="grid gap-1.5 text-sm"><span>收件者</span>
              {!recipient ? <div className="flex gap-2"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input aria-label="搜尋收件者" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="h-10 w-full rounded-md border bg-background pl-9 pr-3" placeholder="姓名或 email" /></div><Button type="button" variant="outline" onClick={() => setSearchQuery(searchInput)}>搜尋</Button></div> : <div className="flex items-center rounded-md border px-3 py-2"><span className="text-sm">{recipient.displayName}（{recipient.email}）</span><button type="button" className="ml-auto" aria-label="清除收件者" onClick={() => setRecipient(null)}><X className="h-4 w-4" /></button></div>}
              {!recipient && <span className="text-xs text-muted-foreground">輸入後按搜尋，並從結果中點選一位同仁。收件者須至少登入系統一次才會出現在名單中。</span>}
              {users.data && users.data.length > 0 && !recipient && <div className="overflow-hidden rounded-md border">{users.data.map((user) => <button key={user.id} type="button" className="block w-full border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted" onClick={() => { setRecipient(user); setSearchQuery(''); setSearchInput(''); }}>{user.displayName} <span className="text-muted-foreground">{user.email}</span></button>)}</div>}
              {users.data && users.data.length === 0 && !recipient && <span className="text-xs text-destructive">找不到符合的帳號。請確認姓名／Email，並請該同仁先登入系統一次。</span>}
              {users.isError && <span className="text-xs text-destructive">{friendlyErrorMessage(users.error)}</span>}
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm"><span>權限</span><select aria-label="分享權限" value={accessLevel} onChange={(event) => setAccessLevel(event.target.value as ShareAccessLevel)} className="h-10 rounded-md border bg-background px-3"><option value="view">唯讀</option><option value="edit">可編輯（只會修改遮蔽副本）</option></select></label>
              <label className="grid gap-1.5 text-sm"><span>有效時數（1–720）</span><input aria-label="有效時數" type="number" min="1" max="720" value={durationHours} onChange={(event) => setDurationHours(event.target.value)} className="h-10 rounded-md border bg-background px-3" /></label>
            </div>
            <fieldset className="grid gap-3 rounded-md border border-dashed p-3"><legend className="px-1 text-sm font-medium">個資欄位遮蔽（選填）</legend><p className="text-xs text-muted-foreground">請填 Excel 工作表名稱與第一列欄位名稱；建立時會驗證並生成獨立遮蔽副本。</p><div className="grid gap-2 sm:grid-cols-4"><input aria-label="工作表名稱" value={ruleSheet} onChange={(event) => setRuleSheet(event.target.value)} className="h-10 rounded-md border bg-background px-3" placeholder="工作表" /><input aria-label="欄位名稱" value={ruleHeader} onChange={(event) => setRuleHeader(event.target.value)} className="h-10 rounded-md border bg-background px-3" placeholder="第一列欄名" /><select aria-label="遮蔽方式" value={ruleMode} onChange={(event) => setRuleMode(event.target.value as MaskMode)} className="h-10 rounded-md border bg-background px-3"><option value="redact">完全遮蔽</option><option value="partial">部分隱碼</option></select><Button type="button" variant="outline" onClick={addRule} disabled={!ruleSheet.trim() || !ruleHeader.trim()}>新增欄位</Button></div>{rules.length > 0 && <ul className="space-y-1">{rules.map((rule, index) => <li key={`${rule.sheetName}-${rule.header}-${index}`} className="flex items-center gap-2 text-sm"><ShieldOff className="h-4 w-4 text-muted-foreground" />{rule.sheetName}／{rule.header}（{rule.mode === 'redact' ? '完全遮蔽' : '部分隱碼'}）<button type="button" aria-label={`移除 ${rule.header}`} className="ml-auto" onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}><X className="h-4 w-4" /></button></li>)}</ul>}</fieldset>
            {create.isError && <p className="text-sm text-destructive">{shareErrorMessage(create.error)}</p>}
            <div className="flex flex-col items-end gap-1"><Button disabled={!recipient || create.isPending} onClick={() => create.mutate()}>{create.isPending ? '建立中…' : '建立分享'}</Button>{!recipient && <span className="text-xs text-muted-foreground">請先從搜尋結果選擇收件者</span>}</div>
          </section>
          <section className="mt-5"><h3 className="mb-3 font-medium">已建立的分享</h3>{shares.isLoading && <p className="text-sm text-muted-foreground">載入中…</p>}{shares.isError && <p className="text-sm text-destructive">{friendlyErrorMessage(shares.error)}</p>}<div className="space-y-2">{shares.data?.map((share) => <div key={share.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="font-medium">{share.recipient ? `${share.recipient.displayName}（${share.recipient.email}）` : '帳號已不存在'}</div><div>{share.accessLevel === 'edit' ? '可編輯' : '唯讀'}・到期：{formatDate(share.expiresAt)}</div><div className="text-xs text-muted-foreground">{share.revokedAt ? `已撤銷：${formatDate(share.revokedAt)}` : share.maskRules?.length ? `已遮蔽 ${share.maskRules.length} 個欄位` : '未遮蔽'}</div></div>{!share.revokedAt && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={extend.isPending} onClick={() => extend.mutate(share.id)}>延長 24 小時</Button><Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(share.id)}>撤銷</Button></div>}</div>)}{shares.data?.length === 0 && <p className="text-sm text-muted-foreground">尚未建立分享。</p>}</div></section>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
