// The site's own admin roster (Cloudflare Access decides who may sign in at all; this list decides who
// gets into /admin and with which role).

import { ChangeSet } from './changes';
import { db } from './db';
import { N_, isLang, summary, UserError, type Lang } from './i18n';

export const ROLES = ['owner', 'admin', 'editor'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_NAMES: Record<Role, string> = {
  owner: N_('站长'),
  admin: N_('管理员'),
  editor: N_('整理员'),
};

export const ROLE_HELP: Record<Role, string> = {
  owner: N_('全部权限，可以任免站长'),
  admin: N_('全部整理权限，可以管理管理员与整理员、清理存储'),
  editor: N_('整理、上传、编辑作品与撤销；不能管理成员、不能清理存储'),
};

type Actor = NonNullable<App.Locals['admin']>;

/** Managing members and purging storage need an owner or admin. */
export function canManage(actor: Actor | undefined): boolean {
  return actor?.role === 'owner' || actor?.role === 'admin';
}

export interface Member {
  email: string;
  name: string | null;
  role: Role;
  lang: Lang | null; // interface language; null = from the browser
  created_at: string;
}

/** '' (from the browser) or a language. */
function checkLang(raw: string): Lang | null {
  if (raw === '') return null;
  if (!isLang(raw)) throw new UserError('未知的语言');
  return raw;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function owners(): Promise<number> {
  const row = await db().prepare("SELECT count(*) AS n FROM admins WHERE role = 'owner'").first<{ n: number }>();
  return row?.n ?? 0;
}

function checkRole(actor: Actor, role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new UserError('未知的角色');
  if (role === 'owner' && actor.role !== 'owner') throw new UserError('只有站长可以任命站长');
  return role as Role;
}

export async function addMember(actor: Actor, emailRaw: string, name: string, roleRaw: string, langRaw = ''): Promise<string> {
  if (!canManage(actor)) throw new UserError('没有管理成员的权限');
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new UserError('邮箱格式不对');
  const role = checkRole(actor, roleRaw);
  if (await db().prepare('SELECT 1 FROM admins WHERE email = ?').bind(email).first()) throw new UserError('{email} 已在名单里', { email });
  const cs = new ChangeSet(db(), actor.email, summary('管理组：加入 {email}（{role}）', { email, role: ROLE_NAMES[role] }));
  cs.create('admin', { email, name: name.trim().slice(0, 100) || null, role, lang: checkLang(langRaw) });
  await cs.commit();
  return email;
}

export async function updateMember(actor: Actor, email: string, name: string, roleRaw: string, langRaw = ''): Promise<number> {
  if (!canManage(actor)) throw new UserError('没有管理成员的权限');
  const current = await db().prepare('SELECT email, name, role, lang FROM admins WHERE email = ?').bind(email).first<Member>();
  if (!current) throw new UserError('找不到这个成员');
  const role = checkRole(actor, roleRaw);
  if (current.role === 'owner' && actor.role !== 'owner') throw new UserError('只有站长可以修改站长');
  if (current.role === 'owner' && role !== 'owner' && (await owners()) <= 1) throw new UserError('至少要保留一位站长');
  const cs = new ChangeSet(db(), actor.email, summary('管理组：修改 {email}', { email }));
  const patch = { name: name.trim().slice(0, 100) || null, role, lang: checkLang(langRaw) };
  cs.updateKnown('admin', { email }, current as unknown as Record<string, unknown>, patch);
  return cs.commit();
}

export async function removeMember(actor: Actor, email: string): Promise<void> {
  if (!canManage(actor)) throw new UserError('没有管理成员的权限');
  if (email === actor.email) throw new UserError('不能移除自己');
  const current = await db().prepare('SELECT role FROM admins WHERE email = ?').bind(email).first<{ role: Role }>();
  if (!current) throw new UserError('找不到这个成员');
  if (current.role === 'owner' && actor.role !== 'owner') throw new UserError('只有站长可以移除站长');
  const cs = new ChangeSet(db(), actor.email, summary('管理组：移除 {email}', { email }));
  await cs.delete('admin', { email });
  await cs.commit();
}
