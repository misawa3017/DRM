import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PermissionsTable } from '../../src/components/PermissionsTable';
import type { GlobalPermissionEntry, PermissionEntry } from '../../src/api/permissions';

describe('PermissionsTable', () => {
  it('renders principal, level, and grantedAt for each entry without a resource column', () => {
    const entries: PermissionEntry[] = [
      {
        id: 'p1',
        resourceType: 'folder',
        resourceId: 'f1',
        principalType: 'user',
        principalId: 'u1',
        permissionLevel: 'edit',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'a@example.com', displayName: 'Alice' },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={false} onRevoke={vi.fn()} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.queryByText('資源')).not.toBeInTheDocument();
  });

  it('renders resource name/path and source when showResourceColumn is true', () => {
    const entries: GlobalPermissionEntry[] = [
      {
        id: 'p2',
        resourceType: 'document',
        resourceId: 'd1',
        principalType: 'user',
        principalId: 'u2',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'b@example.com', displayName: 'Bob' },
        resourceName: '董事會簡報.pdf',
        resourcePath: 'Root / 財務部',
        source: { inheritedFrom: { resourceId: 'f1', resourceName: '財務部' } },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={true} onRevoke={vi.fn()} />);

    expect(screen.getByText('董事會簡報.pdf')).toBeInTheDocument();
    expect(screen.getByText('Root / 財務部')).toBeInTheDocument();
    expect(screen.getAllByText(/財務部/).length).toBeGreaterThan(0);
  });

  it('calls onRevoke with the permission id when the revoke button is clicked', () => {
    const onRevoke = vi.fn();
    const entries: PermissionEntry[] = [
      {
        id: 'p3',
        resourceType: 'folder',
        resourceId: 'f1',
        principalType: 'user',
        principalId: 'u3',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'c@example.com', displayName: 'Carol' },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={false} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByTestId('revoke-p3'));

    expect(onRevoke).toHaveBeenCalledWith('p3');
  });
});
