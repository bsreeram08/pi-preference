import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childFastMode, { applyPriorityServiceTier } from "../child-fast-mode.ts";

describe("child fast mode", () => {
  test("preserves provider payload fields while requesting priority service", () => {
    const payload = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }], nested: { keep: true }, service_tier: "default" };
    const rewritten = applyPriorityServiceTier(payload);

    expect(rewritten).toEqual({ ...payload, service_tier: "priority" });
    expect(rewritten).not.toBe(payload);
    expect((rewritten as typeof payload).messages).toBe(payload.messages);
    expect((rewritten as typeof payload).nested).toBe(payload.nested);
  });

  test("registers a direct provider-payload replacement rather than a wrapper", async () => {
    let handler: ((event: { payload: unknown }) => unknown | Promise<unknown>) | undefined;
    childFastMode({
      on(event: string, registered: (event: { payload: unknown }) => unknown | Promise<unknown>) {
        expect(event).toBe("before_provider_request");
        handler = registered;
      },
    } as unknown as ExtensionAPI);

    const payload = { model: "gpt-5.6-sol", input: ["hello"] };
    const replacement = await handler?.({ payload });
    expect(replacement).toEqual({ ...payload, service_tier: "priority" });
    expect(replacement).not.toHaveProperty("payload");
  });

  test("leaves non-object and array payloads untouched", () => {
    for (const payload of [undefined, null, "payload", 42, true]) {
      expect(applyPriorityServiceTier(payload)).toBe(payload);
    }
    const arrayPayload = [{ model: "gpt-5.6-sol" }];
    expect(applyPriorityServiceTier(arrayPayload)).toBe(arrayPayload);
  });
});
