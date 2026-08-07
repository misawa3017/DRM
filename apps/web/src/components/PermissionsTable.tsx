import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import type { GlobalPermissionEntry, PermissionEntry } from '../api/permissions';

const LEVEL_LABEL_CLASS: Record<string, string> = {
  view: 'bg-muted text-muted-foreground',
  download: 'bg-blue-100 text-blue-800',
  edit: 'bg-amber-100 text-amber-800',
  manage: 'bg-red-100 text-red-800',
};

function isGlobalEntry(
  entry: PermissionEntry | GlobalPermissionEntry,
): entry is GlobalPermissionEntry {
  return 'resourceName' in entry;
}

interface PermissionsTableProps {
  entries: PermissionEntry[] | GlobalPermissionEntry[];
  showResourceColumn: boolean;
  onRevoke: (permissionId: string) => void;
}

export function PermissionsTable({ entries, showResourceColumn, onRevoke }: PermissionsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showResourceColumn && <TableHead>資源</TableHead>}
          <TableHead>使用者</TableHead>
          <TableHead>權限層級</TableHead>
          <TableHead>授權時間</TableHead>
          {showResourceColumn && <TableHead>來源</TableHead>}
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            {showResourceColumn && isGlobalEntry(entry) && (
              <TableCell>
                <div>{entry.resourceName}</div>
                <div className="text-xs text-muted-foreground">{entry.resourcePath}</div>
              </TableCell>
            )}
            <TableCell>
              <div>{entry.principal?.displayName ?? entry.principalId}</div>
              {entry.principal && (
                <div className="text-xs text-muted-foreground">{entry.principal.email}</div>
              )}
            </TableCell>
            <TableCell>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${LEVEL_LABEL_CLASS[entry.permissionLevel] ?? ''}`}
              >
                {entry.permissionLevel}
              </span>
            </TableCell>
            <TableCell>{new Date(entry.grantedAt).toLocaleDateString()}</TableCell>
            {showResourceColumn && isGlobalEntry(entry) && (
              <TableCell className="text-xs text-muted-foreground">
                {entry.source === 'direct' ? '直接管理' : `繼承自「${entry.source.inheritedFrom.resourceName}」`}
              </TableCell>
            )}
            <TableCell>
              <Button
                variant="outline"
                size="sm"
                data-testid={`revoke-${entry.id}`}
                onClick={() => onRevoke(entry.id)}
              >
                撤銷
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
