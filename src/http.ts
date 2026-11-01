import { InvalidInput } from './settings';

export const readBody = (req: Request, maxBytes = 64_000) => readJsonStream(req.body, maxBytes);
export const readResponseBody = (res: Response, maxBytes = 1_000_000) => readJsonStream(res.body, maxBytes);

const readJsonStream = async (body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<unknown> => JSON.parse(await readTextStream(body, maxBytes));

export async function readTextStream(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) throw new InvalidInput('A JSON body is required');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new InvalidInput('Request is too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function readObject(req: Request): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidInput('Expected a JSON object');
  return body as Record<string, unknown>;
}
