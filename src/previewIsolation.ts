// Branch previews set PREVIEW_ISOLATION=true. Production does not set it.
// The marker is the only switch. Missing, empty, or any other value keeps production behavior.

export class PreviewBlocked extends Error {
  constructor() {
    super('Isolated preview does not call Upwork, Apify, Claude, Loom, or email.');
  }
}

export const isIsolatedPreview = (env: { PREVIEW_ISOLATION?: string }) => env.PREVIEW_ISOLATION === 'true';

export function refusePreview(env: { PREVIEW_ISOLATION?: string }): void {
  if (isIsolatedPreview(env)) throw new PreviewBlocked();
}

// Webhooks, OAuth, intake, and every mutating dashboard call can reach an outside service
// or prepare a send. Reads of the empty preview database stay available.
export function previewRequestBlocked(pathname: string, method: string): boolean {
  if (pathname.startsWith('/oauth/')) return true;
  if (pathname === '/api/apify-webhook' || pathname === '/api/jobs/intake' || pathname === '/api/jobs/scan-intake') return true;
  if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') return true;
  return false;
}
