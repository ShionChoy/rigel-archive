import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { multipartAction, uploadPart } from '../../../../../lib/blobs';

export const POST: APIRoute = async ({ request, params }) => multipartAction(env.MEDIA, params.sha ?? '', request);

export const PUT: APIRoute = async ({ request, url, params }) => uploadPart(env.MEDIA, params.sha ?? '', url, request);
