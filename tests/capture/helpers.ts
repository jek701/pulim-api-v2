// Synthetic media only: tiny hand-built containers, no real audio or images.
const atom = (name: string, data: Buffer) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(name, 4);
  return Buffer.concat([header, data]);
};
export function syntheticM4a(seconds: number): Buffer {
  const header = Buffer.alloc(20); header.writeUInt32BE(1000, 12); header.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([atom('ftyp', Buffer.from('M4A ')), atom('moov', atom('trak', atom('mdia', atom('mdhd', header))))]);
}
export function syntheticJpeg(width: number, height: number): Buffer {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 0, 0, 0, 3, 0xff, 0xd9]);
  data.writeUInt16BE(height, 7); data.writeUInt16BE(width, 9); return data;
}
