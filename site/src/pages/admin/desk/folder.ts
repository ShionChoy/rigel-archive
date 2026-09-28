// The 整理台's folder operations, as JSON: {"op": "create" | "create_many" | "rename" | "info" | "color" |
// "move" | "reorder" | "delete" | "type" | "pin" | "unpin" | "quick_order", ...}. Answers
// {ok, msg, batch} (batch = what 「撤销」 undoes), or {ok: false, err} / {conflict: [names]} /
// {confirm: text} when the admin has to choose.
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../lib/api';
import {
  ConfirmError, ConflictError, createFolder, createFolders, deleteFolders, mergeFolder, moveFolders, pinFolder, renameFolder, reorderFolders,
  reorderQuickAccess, setFolderType, updateFolderInfo, type ConflictMode, type FolderResult,
} from '../../../lib/folders';
import { FOLDER_TYPES, type FolderType } from '../../../lib/locations';
import { errorText, summaryText, UserError } from '../../../lib/i18n';
import { isOneOf } from '../../../lib/constants';

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 5000) : []);

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  const actor = locals.admin!.email;
  try {
    const body = await readJson(request);
    let r: FolderResult | null = null;
    switch (body.op) {
      case 'create':
        r = await createFolder(actor, str(body.under), str(body.name), t);
        break;
      case 'create_many':
        r = await createFolders(actor, str(body.under), str(body.text), t);
        break;
      case 'rename':
        r = await renameFolder(actor, str(body.id), str(body.name), t);
        break;
      case 'info':
        r = await updateFolderInfo(actor, str(body.id), { description: str(body.description), readme_file_id: str(body.readme_file_id) }, t);
        break;
      case 'color':
        r = await updateFolderInfo(actor, str(body.id), { color: str(body.color) }, t);
        break;
      case 'move': {
        const mode = str(body.mode) || 'ask';
        if (!isOneOf(['ask', 'merge', 'both'] as const, mode)) throw new UserError('未知的操作');
        r = await moveFolders(actor, ids(body.ids), str(body.under), mode as ConflictMode, t);
        break;
      }
      case 'merge':
        r = await mergeFolder(actor, str(body.id), str(body.into), t);
        break;
      case 'reorder':
        r = await reorderFolders(actor, str(body.under), body.order === null ? null : ids(body.order), t);
        break;
      case 'delete':
        r = await deleteFolders(actor, ids(body.ids), body.confirmed === true, t);
        break;
      case 'type': {
        const type = str(body.type);
        if (!isOneOf(FOLDER_TYPES, type)) throw new UserError('未知的类型');
        const o = (body.options ?? {}) as Record<string, unknown>;
        r = await setFolderType(actor, str(body.id), type as FolderType, {
          kind: o.kind === undefined ? undefined : str(o.kind),
          catalog_no: o.catalog_no === undefined ? undefined : str(o.catalog_no),
          title: o.title === undefined ? undefined : str(o.title),
          slot: o.slot === undefined ? undefined : str(o.slot),
          new_type: o.new_type === undefined ? undefined : str(o.new_type),
          name: o.name === undefined ? undefined : str(o.name),
        }, t);
        break;
      }
      case 'pin':
      case 'unpin':
        await pinFolder(actor, str(body.id), body.op === 'pin');
        return json({ ok: true, msg: body.op === 'pin' ? t('已加入快速访问') : t('已移出快速访问'), batch: null });
      case 'quick_order':
        await reorderQuickAccess(actor, ids(body.order));
        return json({ ok: true, msg: '', batch: null });
      default:
        throw new UserError('未知的操作');
    }
    return json({ ok: true, msg: summaryText(r.summary, t), batch: r.batchId, changed: r.changed, id: r.id ?? null, parent: r.parent ?? null });
  } catch (e) {
    // The admin chooses (merge or keep both; delete anyway): an answer, not a failure.
    if (e instanceof ConflictError) return json({ ok: false, err: errorText(e, t), conflict: e.names });
    if (e instanceof ConfirmError) return json({ ok: false, err: errorText(e, t), confirm: errorText(e, t) });
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
