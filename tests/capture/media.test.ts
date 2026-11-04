import { describe, expect, it } from 'vitest';
import { syntheticJpeg, syntheticM4a } from './helpers';
import { audioDuration, captureAudioFile, jpegDimensions, MAX_CAPTURE_BYTES, validateCaptureMedia } from '../../src/capture/upload';

describe('bounded memory-only capture media', () => {
  it('checks the m4a container duration: 60 s recordings pass with a 2 s timer tolerance', () => {
    expect(audioDuration(syntheticM4a(60))).toBe(60);
    expect(() => validateCaptureMedia(syntheticM4a(60), 'audio/mp4', 'audio')).not.toThrow();
    expect(() => validateCaptureMedia(syntheticM4a(60.4), 'audio/mp4', 'audio')).not.toThrow();
    expect(() => validateCaptureMedia(syntheticM4a(62), 'audio/mp4', 'audio')).not.toThrow();
    expect(() => validateCaptureMedia(syntheticM4a(62.5), 'audio/mp4', 'audio')).toThrow();
    expect(() => validateCaptureMedia(syntheticM4a(0), 'audio/mp4', 'audio')).toThrow();
  });
  it('trusts the container, not the label: untyped uploads pass, wrong containers do not', () => {
    expect(() => validateCaptureMedia(syntheticM4a(5), 'application/octet-stream', 'audio')).not.toThrow();
    expect(() => validateCaptureMedia(Buffer.from('not audio at all'), 'application/octet-stream', 'audio')).toThrow();
    expect(captureAudioFile(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0xe0, 0]))).toEqual({ name: 'capture.aac', mime: 'audio/aac' });
    expect(captureAudioFile(syntheticM4a(1))).toEqual({ name: 'capture.m4a', mime: 'audio/mp4' });
    expect(() => validateCaptureMedia(syntheticJpeg(100, 100), 'image/jpg', 'image')).not.toThrow();
  });
  it('reads AAC frame duration and rejects truncated ADTS', () => {
    const frame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0xe0, 0]); // 7-byte 44.1kHz frame
    expect(audioDuration(frame)).toBeCloseTo(1024 / 44100);
    expect(() => audioDuration(frame.subarray(0, 6))).toThrow();
  });
  it('checks actual JPEG dimensions and file signatures rather than client labels', () => {
    expect(jpegDimensions(syntheticJpeg(2000, 1000))).toEqual({ width: 2000, height: 1000 });
    expect(() => validateCaptureMedia(syntheticJpeg(2000, 1000), 'image/jpeg', 'image')).not.toThrow();
    expect(() => validateCaptureMedia(syntheticJpeg(2001, 1000), 'image/jpeg', 'image')).toThrow();
    expect(() => validateCaptureMedia(Buffer.from('not a jpeg'), 'image/jpeg', 'image')).toThrow();
    expect(() => validateCaptureMedia(syntheticJpeg(100, 100), 'image/png', 'image')).toThrow();
  });
  it('rejects oversized uploads and malformed media', () => {
    expect(() => validateCaptureMedia(Buffer.alloc(MAX_CAPTURE_BYTES + 1), 'audio/mp4', 'audio')).toThrow();
    expect(() => validateCaptureMedia(Buffer.from('arbitrary'), 'audio/aac', 'audio')).toThrow();
    expect(() => validateCaptureMedia(syntheticM4a(1), 'audio/ogg', 'audio')).toThrow();
  });
});
