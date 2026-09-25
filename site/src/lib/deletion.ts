// Deleting files. Only records are deleted: source/ is never touched, and stored content stays until
// the storage cleanup (/admin/storage) removes objects no file has referenced for STORAGE_GRACE_DAYS.
//
// A file can be deleted when it was uploaded in the admin, or when it comes from the 合辑 but its
// original is gone from source/ (a later import would otherwise bring it straight back). Published
// files must be unpublished first. An archive goes together with everything unpacked from it.

import { ChangeSet } from './changes';
import { N_, summary as summaryOf, type T } from './i18n';

/** SQL condition: a 合辑 row whose original was not seen by the latest import. */
export function originalGone(t: string): string {
  return `(${t}.origin = 'nas' AND EXISTS (SELECT 1 FROM meta WHERE meta.key = 'nas_seen'
    AND (${t}.source_seen IS NULL OR ${t}.source_seen < meta.value)))`;
}

interface Node {
  id: string;
  member_of: string | null;
  origin: string;
  state: string;
  gone: number;
}

export interface DeletePlan {
  levels: string[][]; // archives before their members
  count: number;
  members: number; // deleted because the archive containing them is deleted
  keptNas: number; // requested 合辑 files whose original still exists
  keptPublished: number;
  keptMembers: number; // requested archives with a member that cannot be deleted
}

export type KeepReason = 'nas' | 'published' | 'member' | null;

export function keepReason(f: { origin: string; state: string; gone: number | boolean }): KeepReason {
  if (f.state === 'published') return 'published';
  if (f.origin === 'nas' && !f.gone) return 'nas';
  return null;
}

export const KEEP_REASON_TEXT: Record<Exclude<KeepReason, null>, string> = {
  nas: N_('合辑文件的原件还在 source 里，只能「忽略」（删除后重新导入又会出现）'),
  published: N_('已发布的文件要先改为其他状态才能删除'),
  member: N_('包内有不能删除的文件'),
};

export async function planDelete(db: D1Database, ids: string[]): Promise<DeletePlan> {
  const nodes = new Map<string, Node>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `WITH RECURSIVE t(id) AS (
           SELECT id FROM files WHERE id IN (${chunk.map(() => '?').join(', ')})
           UNION SELECT f.id FROM files f JOIN t ON f.member_of = t.id)
         SELECT f.id, f.member_of, f.origin, f.state, ${originalGone('f')} AS gone FROM t JOIN files f ON f.id = t.id`,
      )
      .bind(...chunk)
      .all<Node>();
    for (const n of results) nodes.set(n.id, n);
  }

  // A file that cannot be deleted keeps the archives that contain it.
  const blocked = new Map<string, KeepReason>();
  for (const n of nodes.values()) {
    const reason = keepReason(n);
    if (!reason) continue;
    blocked.set(n.id, reason);
    for (let p = n.member_of; p && nodes.has(p) && !blocked.has(p); p = nodes.get(p)!.member_of) blocked.set(p, 'member');
  }

  const level = new Map<string, number>();
  const depth = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    const parent = nodes.get(id)!.member_of;
    const d = parent && nodes.has(parent) ? depth(parent) + 1 : 0;
    level.set(id, d);
    return d;
  };
  const levels: string[][] = [];
  for (const id of nodes.keys()) {
    if (blocked.has(id)) continue;
    (levels[depth(id)] ??= []).push(id);
  }

  const count = levels.reduce((n, l) => n + l.length, 0);
  const tally = (r: KeepReason) => ids.filter((id) => blocked.get(id) === r).length;
  return {
    levels: levels.filter(Boolean),
    count,
    members: count - ids.filter((id) => nodes.has(id) && !blocked.has(id)).length,
    keptNas: tally('nas'),
    keptPublished: tally('published'),
    keptMembers: tally('member'),
  };
}

export async function deleteFiles(db: D1Database, actor: string, ids: string[]): Promise<DeletePlan & { summary: string }> {
  const plan = await planDelete(db, ids);
  const summary = plan.members
    ? summaryOf('删除 {n} 个文件（含包内 {members} 个）', { n: plan.count, members: plan.members })
    : summaryOf('删除 {n} 个文件', { n: plan.count });
  if (plan.count > 0) {
    const cs = new ChangeSet(db, actor, summary);
    cs.deleteFiles(plan.levels);
    await cs.commit();
  }
  return { ...plan, summary };
}

/** Why some of the requested files were kept, e.g. 「；3 个已发布，要先改状态」 (empty when none were). */
export function keptMessage(plan: DeletePlan, t: T): string {
  const parts = [
    plan.keptNas && t('{n} 个合辑文件的原件还在，只能忽略', { n: plan.keptNas }),
    plan.keptPublished && t('{n} 个已发布，要先改状态', { n: plan.keptPublished }),
    plan.keptMembers && t('{n} 个压缩包里有不能删除的文件', { n: plan.keptMembers }),
  ].filter(Boolean);
  return parts.length ? t('；') + parts.join(t('；')) : '';
}
