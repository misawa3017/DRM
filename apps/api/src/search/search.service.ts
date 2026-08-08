import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

export interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

const SEARCH_RESULT_LIMIT = 50;

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async search(user: AuthenticatedUser, query: string): Promise<SearchResultItem[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const [folders, documents] = await Promise.all([
      this.prisma.folder.findMany({
        where: { name: { contains: trimmed, mode: 'insensitive' }, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.prisma.document.findMany({
        where: { name: { contains: trimmed, mode: 'insensitive' }, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
    ]);

    const [folderAllowed, documentAllowed] = await Promise.all([
      Promise.all(folders.map((f) => this.acl.can(user, 'folder', f.id, 'view'))),
      Promise.all(documents.map((d) => this.acl.can(user, 'document', d.id, 'view'))),
    ]);

    const visibleFolders = folders.filter((_, i) => folderAllowed[i]);
    const visibleDocuments = documents.filter((_, i) => documentAllowed[i]);

    const [folderPaths, documentPaths] = await Promise.all([
      Promise.all(visibleFolders.map((f) => this.resolveFolderPath(f.parentId))),
      Promise.all(visibleDocuments.map((d) => this.resolveFolderPath(d.folderId))),
    ]);

    const results: SearchResultItem[] = [
      ...visibleFolders.map((f, i) => ({
        resourceType: 'folder' as const,
        resourceId: f.id,
        name: f.name,
        path: folderPaths[i],
      })),
      ...visibleDocuments.map((d, i) => ({
        resourceType: 'document' as const,
        resourceId: d.id,
        name: d.name,
        path: documentPaths[i],
      })),
    ];

    return results.slice(0, SEARCH_RESULT_LIMIT);
  }

  // Mirrors PermissionsService.resolveFolderPath exactly (ancestor path, "Root" prefix,
  // excludes the resource's own name) — kept as its own small copy here rather than a
  // shared helper, matching this codebase's convention of small per-module logic over
  // cross-module extraction for something this size.
  private async resolveFolderPath(folderId: string | null): Promise<string> {
    const names: string[] = [];
    let currentId = folderId;
    for (let depth = 0; currentId && depth < 100; depth++) {
      const folder: { name: string; parentId: string | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: currentId },
          select: { name: true, parentId: true },
        });
      if (!folder) break;
      names.unshift(folder.name);
      currentId = folder.parentId;
    }
    return ['Root', ...names].join(' / ');
  }
}
