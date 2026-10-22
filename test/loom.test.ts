import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieFrom, copyName, deleteVideos, duplicate, LoomAuthError, LoomError, readDuplicate, videoIdFrom } from '../src/loom';

// Shapes captured from loom.com on Oct 22 (docs/loom-api.md).
const SOURCE = 'eea7d413d42f4c1ebb726c188f54ea74';
const COPY = 'd2130011f48641a29da51d5e0cf2261d';
const duplicated = { data: { duplicateVideo: { __typename: 'DuplicateVideoPayload', newVideo: { __typename: 'RegularUserVideo', id: COPY, name: 'Klaviyo flows' } } } };
const deletedOk = { data: { bulkDeleteVideos: { success: true, __typename: 'BulkDeleteVideosPayload' } } };

const reply = (body: unknown, status = 200, type = 'application/json') =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } }));

afterEach(() => vi.unstubAllGlobals());

describe('helpers', () => {
  it('reads the video id from a share link', () => {
    expect(videoIdFrom(`https://www.loom.com/share/${SOURCE}`)).toBe(SOURCE);
    expect(videoIdFrom(`https://loom.com/share/${SOURCE}?sid=abc`)).toBe(SOURCE);
    expect(videoIdFrom('https://example.com/x')).toBeNull();
  });
  it('accepts the connect.sid value, the name=value pair or a whole cookie line', () => {
    expect(cookieFrom('  s%3Aabc.def ')).toBe('connect.sid=s%3Aabc.def');
    expect(cookieFrom('connect.sid=s%3Aabc')).toBe('connect.sid=s%3Aabc');
    expect(cookieFrom('Cookie: a=1; connect.sid=s%3Aabc')).toBe('a=1; connect.sid=s%3Aabc');
    expect(cookieFrom('')).toBeNull();
    expect(cookieFrom('abc\r\nX-Evil: 1')).toBeNull();
  });
  it('names copies with the job title on one line', () => {
    expect(copyName('  Klaviyo\nflows   for a DTC brand ')).toBe('Klaviyo flows for a DTC brand');
    expect(copyName('x'.repeat(400))).toHaveLength(250);
    expect(copyName('   ')).toBe('Proposal video');
  });
});

describe('readDuplicate', () => {
  it('returns the new video id', () => {
    expect(readDuplicate(duplicated.data)).toEqual({ id: COPY, name: 'Klaviyo flows' });
  });
  it('turns a GenericError into an error, and sign-in problems into an auth error', () => {
    expect(() => readDuplicate({ duplicateVideo: { __typename: 'GenericError', message: 'Video not found' } })).toThrow(LoomError);
    expect(() => readDuplicate({ duplicateVideo: { __typename: 'GenericError', message: 'User is not authorized' } })).toThrow(LoomAuthError);
    expect(() => readDuplicate({ duplicateVideo: { __typename: 'DuplicateVideoPayload' } })).toThrow('did not return the new video id');
    // What loom.com answers for a session that is not signed in (checked Oct 22 with a made-up cookie).
    expect(() => readDuplicate({ duplicateVideo: { __typename: 'UserNotAuthorizedError' } })).toThrow(LoomAuthError);
  });
});

describe('requests', () => {
  it('sends the captured DuplicateVideo request with the cookie', async () => {
    const f = reply(duplicated);
    vi.stubGlobal('fetch', f);
    expect(await duplicate('connect.sid=x', SOURCE, 'Klaviyo flows')).toEqual({ id: COPY, name: 'Klaviyo flows' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.loom.com/graphql');
    expect((init.headers as Record<string, string>).cookie).toBe('connect.sid=x');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ operationName: 'DuplicateVideo', variables: { videoId: SOURCE, newName: 'Klaviyo flows', spaceId: null, password: null } });
  });
  it('deletes copies with BulkDeleteVideos', async () => {
    const f = reply(deletedOk);
    vi.stubGlobal('fetch', f);
    expect(await deleteVideos('connect.sid=x', [COPY])).toBe(true);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).variables).toEqual({ videoIds: [COPY] });
  });
  it('treats 401, a login page or an auth message as an expired session', async () => {
    vi.stubGlobal('fetch', reply({}, 401));
    await expect(duplicate('c', SOURCE, 'n')).rejects.toThrow(LoomAuthError);
    vi.stubGlobal('fetch', reply('<html>Log in</html>', 200, 'text/html'));
    await expect(duplicate('c', SOURCE, 'n')).rejects.toThrow(LoomAuthError);
    vi.stubGlobal('fetch', reply({ errors: [{ message: 'Unauthenticated' }] }));
    await expect(duplicate('c', SOURCE, 'n')).rejects.toThrow(LoomAuthError);
    vi.stubGlobal('fetch', reply({ data: { bulkDeleteVideos: { __typename: 'UserNotAuthorizedError' } } }));
    await expect(deleteVideos('c', [COPY])).rejects.toThrow(LoomAuthError);
  });
  it('keeps other failures as plain Loom errors', async () => {
    vi.stubGlobal('fetch', reply({}, 500));
    await expect(duplicate('c', SOURCE, 'n')).rejects.toThrow('Loom DuplicateVideo failed (500)');
    vi.stubGlobal('fetch', reply({ errors: [{ message: 'Rate limited' }] }));
    const e = await duplicate('c', SOURCE, 'n').catch((x) => x);
    expect(e).toBeInstanceOf(LoomError);
    expect(e).not.toBeInstanceOf(LoomAuthError);
  });
});
