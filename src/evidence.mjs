export async function writeAll(handle, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw new Error("Evidence write made no progress");
    offset += bytesWritten;
  }
}
