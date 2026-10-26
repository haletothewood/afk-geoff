import fs from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { "runs-on": string; permissions?: Record<string, string>; steps: Step[] }>;
};
const read = (name: string): Workflow => parse(fs.readFileSync(`.github/workflows/${name}.yml`, "utf8"));

it("verifies releases before tagging with the publication gates and runtime, without publication authority", () => {
  const publish = read("publish-npm").jobs.publish;
  const workflow = read("verify-release");
  expect(workflow.on).toEqual({ pull_request: null, push: { branches: ["main"] }, workflow_dispatch: null });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs)).toEqual(["verify"]);
  const verify = workflow.jobs.verify;
  if (!verify || !publish) throw new Error("Missing release verification or publication job");
  expect(verify.permissions).toBeUndefined();
  expect(verify["runs-on"]).toBe("ubuntu-latest");
  expect(verify["runs-on"]).toBe(publish["runs-on"]);
  for (const action of ["actions/setup-node@", "pnpm/action-setup@"]) {
    const setup = (steps: Step[]) => steps.find((step) => step.uses?.startsWith(action));
    const publicationSettings = setup(publish.steps)?.with ?? {};
    expect(setup(verify.steps)?.with).toEqual(
      Object.fromEntries(Object.entries(publicationSettings).filter(([key]) => key !== "registry-url"))
    );
  }
  expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"]).toBe(24);
  expect(verify.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"))?.with?.version).toBe("10.20.0");
  const gates = ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm build", "pnpm test", "pnpm test:package"];
  expect(publish.steps.map((step) => step.run).filter((run) => gates.includes(run ?? ""))).toEqual(gates);
  expect(verify.steps.flatMap((step) => step.run ? [step.run] : [])).toEqual(gates);
  expect(verify.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
    "actions/checkout@v6", "pnpm/action-setup@v4", "actions/setup-node@v6"
  ]);
  expect(verify.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(false);
  expect(JSON.stringify(workflow)).not.toMatch(/npm publish|pnpm publish|NPM_TOKEN|NODE_AUTH_TOKEN|id-token|secrets\./);
});
