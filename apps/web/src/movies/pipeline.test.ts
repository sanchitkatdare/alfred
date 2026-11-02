import { describe, expect, it } from "vitest";
import type { DevEntry } from "./devlog";
import { pipelineStages } from "./pipeline";

const entry = (items: DevEntry["items"]): DevEntry => ({ id: 1, kind: "search", title: "q", started: 0, items });

describe("pipelineStages", () => {
  it("shows only rules before a request", () => {
    expect(pipelineStages(null, 0.4).map((s) => [s.id, s.ran, s.ran ? s.time : ""])).toEqual([["rules", true, "< 1 ms"], ["search", false, ""], ["assistant", false, ""]]);
  });

  it("adds the time of each stage that ran", () => {
    const stages = pipelineStages(entry([{ stage: "rules", label: "x" }, { stage: "search", label: "a", ms: 100 }, { stage: "search", label: "b", ms: 50 }]), 2);
    expect(stages[1]).toMatchObject({ ran: true, time: "150 ms" });
    expect(stages[2]!.ran).toBe(false);
  });

  it("shows seconds for long stages", () => {
    expect(pipelineStages(entry([{ stage: "assistant", label: "a", ms: 2500 }]), 2)[2]).toMatchObject({ ran: true, time: "2.5 s" });
  });
});
