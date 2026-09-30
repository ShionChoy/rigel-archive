// Ctrl+K: GET ?q=<text> → {items: [{kind, label, sub, href}]} (lib/jump.ts).
import type { APIRoute } from 'astro';
import { json } from '../../lib/api';
import { jump } from '../../lib/jump';

export const GET: APIRoute = async ({ url, locals }) => json({ items: await jump((url.searchParams.get('q') ?? '').slice(0, 100), locals.t) });
