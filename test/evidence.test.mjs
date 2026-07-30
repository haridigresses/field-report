import assert from "node:assert/strict";
import test from "node:test";
import { writeAll } from "../src/evidence.mjs";

test("writeAll retries short evidence writes until every byte is preserved", async () => {
  const written = [];
  const handle = {
    async write(buffer, offset, length) {
      const bytesWritten = Math.min(3, length);
      written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
      return { bytesWritten };
    }
  };
  await writeAll(handle, Buffer.from("complete evidence"));
  assert.equal(Buffer.concat(written).toString("utf8"), "complete evidence");
});

test("writeAll rejects a writer that makes no progress", async () => {
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("blocked")), /made no progress/);
});
