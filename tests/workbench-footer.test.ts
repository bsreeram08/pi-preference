import { describe, expect, test } from "bun:test";
import { buildContextMeter, contextUsageBand, formatSessionClock } from "../footer-format.ts";

describe("polished footer formatting", () => {
  test("renders a bounded context meter", () => {
    expect(buildContextMeter(30, 12)).toBe("███░░░░░░░░░");
    expect(buildContextMeter(100, 4)).toBe("████");
    expect(buildContextMeter(-10, 4)).toBe("░░░░");
    expect(buildContextMeter(undefined, 4)).toBe("░░░░");
  });

  test("uses semantic context pressure bands", () => {
    expect(contextUsageBand(0)).toBe("low");
    expect(contextUsageBand(59.9)).toBe("low");
    expect(contextUsageBand(60)).toBe("medium");
    expect(contextUsageBand(84.9)).toBe("medium");
    expect(contextUsageBand(85)).toBe("near-limit");
    expect(contextUsageBand(undefined)).toBe("unknown");
  });

  test("matches the minute-and-second session clock style", () => {
    expect(formatSessionClock(0, (1277 * 60 + 12) * 1000)).toBe("1277m12s");
  });
});
