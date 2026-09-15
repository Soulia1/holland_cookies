import { describe, expect, it } from "vitest";
import { parseStamp } from "./dates";

describe("reading the API's timestamps", () => {
  it("reads the ISO timestamps the API sends", () => {
    expect(parseStamp("2026-09-15T11:36:00.000Z").toISOString()).toBe("2026-09-15T11:36:00.000Z");
  });

  it("still reads the old SQLite shape as UTC", () => {
    expect(parseStamp("2026-09-15 11:36:00").toISOString()).toBe("2026-09-15T11:36:00.000Z");
    expect(parseStamp("2026-09-15 11:36").toISOString()).toBe("2026-09-15T11:36:00.000Z");
  });

  it("never turns a valid stamp into Invalid Date", () => {
    for (const stamp of ["2026-09-15T11:36:00.000Z", "2026-09-15T14:36:00+03:00", "2026-09-15 11:36:00"]) {
      expect(Number.isNaN(parseStamp(stamp).getTime()), stamp).toBe(false);
    }
  });
});
