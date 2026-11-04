import Busboy from 'busboy';
import type { Request } from 'express';
import { AppError } from '../utils/AppError';

export const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
/** The app stops at 60 s; the container length can overshoot that by a fraction of a second. */
export const MAX_CAPTURE_AUDIO_SECONDS = 62;
const invalid = () => AppError.badRequest('Invalid capture media.');

/** Memory-only, bounded uploads: never write audio or receipt images to disk. */
export async function readCaptureUpload(req: Request, field: 'audio' | 'image') {
  return new Promise<{ buffer: Buffer; mime: string; fields: Record<string, string> }>((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({ headers: req.headers, limits: {
        // busboy emits `partsLimit` on REACHING the limit (files/fields: on exceeding), so allow one more
        // than the 1 file + 2 fields we accept and treat the event as "too many parts".
        files: 1, fileSize: MAX_CAPTURE_BYTES, fields: 2, fieldSize: 128, parts: 4,
      } });
    } catch { reject(invalid()); return; }
    const fields: Record<string, string> = {};
    let media: { buffer: Buffer; mime: string } | undefined;
    let failed = false;
    let bytes = 0;
    const fail = () => { failed = true; };
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE_BYTES + 16_384) {
        failed = true;
        req.unpipe(parser);
        parser.destroy();
        reject(invalid());
        req.resume();
      }
    });
    req.once('aborted', () => { reject(invalid()); parser.destroy(); });
    req.once('error', () => { reject(invalid()); parser.destroy(); });
    parser.on('file', (name, stream, info) => {
      if (name !== field) fail();
      const chunks: Buffer[] = [];
      stream.on('limit', fail);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', () => reject(invalid()));
      stream.on('end', () => { media = { buffer: Buffer.concat(chunks), mime: info.mimeType }; });
    });
    parser.on('field', (name, value, info) => {
      if (!['language', 'timezone'].includes(name) || info.valueTruncated || name in fields) fail();
      fields[name] = value;
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, fail);
    parser.on('error', () => reject(invalid()));
    parser.on('close', () => {
      if (failed || !media?.buffer.length) reject(invalid());
      else resolve({ ...media, fields });
    });
    req.pipe(parser);
  });
}

export function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.readUInt16BE(0) !== 0xffd8) throw invalid();
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 0xff) throw invalid();
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw invalid();
}

/** Read container duration rather than trusting a client-supplied duration field. */
export function audioDuration(buffer: Buffer): number {
  if (buffer.length < 7) throw invalid();
  if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let duration = 0;
    for (let pos = 0; pos < buffer.length;) {
      if (pos + 7 > buffer.length || buffer[pos] !== 0xff || (buffer[pos + 1] & 0xf6) !== 0xf0) throw invalid();
      const rate = rates[(buffer[pos + 2] >> 2) & 15];
      const size = ((buffer[pos + 3] & 3) << 11) | (buffer[pos + 4] << 3) | (buffer[pos + 5] >> 5);
      if (!rate || size < 7 || pos + size > buffer.length) throw invalid();
      duration += 1024 * ((buffer[pos + 6] & 3) + 1) / rate;
      pos += size;
    }
    return duration;
  }
  if (buffer.length < 8 || buffer.toString('ascii', 4, 8) !== 'ftyp') throw invalid();
  const durations: number[] = [];
  const scan = (start: number, end: number, depth: number) => {
    if (depth > 6) throw invalid();
    for (let pos = start; pos + 8 <= end;) {
      let size = buffer.readUInt32BE(pos);
      const type = buffer.toString('ascii', pos + 4, pos + 8);
      let header = 8;
      if (size === 1) { if (pos + 16 > end) throw invalid(); size = Number(buffer.readBigUInt64BE(pos + 8)); header = 16; }
      if (size === 0) size = end - pos;
      if (size < header || pos + size > end) throw invalid();
      const data = pos + header;
      if (['moov', 'trak', 'mdia'].includes(type)) scan(data, pos + size, depth + 1);
      if (type === 'mdhd') {
        const v1 = buffer[data] === 1;
        const scaleAt = data + (v1 ? 20 : 12);
        if (scaleAt + (v1 ? 12 : 8) > pos + size) throw invalid();
        const scale = buffer.readUInt32BE(scaleAt);
        const duration = v1 ? Number(buffer.readBigUInt64BE(scaleAt + 4)) : buffer.readUInt32BE(scaleAt + 4);
        if (!scale) throw invalid();
        durations.push(duration / scale);
      }
      pos += size;
    }
  };
  scan(0, buffer.length, 0);
  if (!durations.length) throw invalid();
  return Math.max(...durations);
}

/** Container sniffing decides the provider file name; the client label is never trusted. */
export function captureAudioFile(buffer: Buffer): { name: string; mime: string } {
  const adts = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
  return adts ? { name: 'capture.aac', mime: 'audio/aac' } : { name: 'capture.m4a', mime: 'audio/mp4' };
}

const AUDIO_MIME = ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg4-generic', 'application/octet-stream'];

export function validateCaptureMedia(buffer: Buffer, mime: string, kind: 'audio' | 'image'): void {
  if (!buffer.length || buffer.length > MAX_CAPTURE_BYTES) throw invalid();
  if (kind === 'image') {
    if (!['image/jpeg', 'image/jpg'].includes(mime) || buffer.length < 4) throw invalid();
    const { width, height } = jpegDimensions(buffer);
    if (width < 1 || height < 1 || Math.max(width, height) > 2000) throw invalid();
  } else {
    if (!AUDIO_MIME.includes(mime)) throw invalid();
    const duration = audioDuration(buffer);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CAPTURE_AUDIO_SECONDS) throw invalid();
  }
}
