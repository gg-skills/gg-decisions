#!/usr/bin/env -S npx tsx

/**
 * @fileoverview Unit tests for decision page generation covering contract validation, HTML output, CLI artifact writing, and token selection summarization.
 *
 * This file owns regression coverage for the decision-page pipeline: declarative dependency validation, HTML rendering with clipboard hooks, and token-block selection parsing.
 * Flow: build fixture definition -> exercise validateDecisionPageDefinition / buildHtml / summarizeSelections -> assert output fields and error conditions.
 *
 * @testing tsx standalone: npx tsx skills/decisions/tests/decision-page-generator.unit.test.ts
 * @see skills/decisions/scripts/decision-page-contract.ts - Decision page contract validator under test whose dependency logic is asserted here.
 * @see skills/decisions/scripts/generate-decision-page.ts - HTML generator under test whose output rendering is asserted here.
 * @see skills/decisions/scripts/decision-page-session.ts - Session summarizer under test whose token-block parsing is asserted here.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */


import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  validateDecisionPageDefinition,
  type DecisionPageDefinition,
} from "../scripts/decision-page-contract.js";
import { buildHtml } from "../scripts/generate-decision-page.js";
import {
  summarizeSelections,
} from "../scripts/decision-page-session.js";

/**
 * Named synchronous test case executed by this file's lightweight harness.
 *
 * @remarks
 * Each `run` closure should assert via `node:assert/strict`; failures are caught and counted by `runTests`.
 */
type UnitTest = {
  name: string;
  run: () => void;
};

/**
 * Creates a unique temporary directory for isolated CLI and filesystem fixtures.
 *
 * @remarks
 * I/O: Synchronously allocates under `os.tmpdir()` via `fs.mkdtempSync`.
 *
 * @param prefix - Leading segment for the temp directory name; must be safe for the host filesystem.
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Runs tests sequentially, logging pass/fail lines and returning a failure count.
 *
 * @remarks
 * Swallows per-test throws so the harness can report every case; callers decide how to exit.
 *
 * @param tests - Cases executed in array order.
 * @returns Number of tests that threw; `0` when every case passed.
 */
function runTests(tests: UnitTest[]): number {
  let failures = 0;
  for (const test of tests) {
    try {
      test.run();
      console.log(`PASS ${test.name}`);
    } catch (error: unknown) {
      failures += 1;
      console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
  return failures;
}

/**
 * Builds the shared `DecisionPageDefinition` fixture used across contract, HTML, CLI, and summarizer assertions.
 *
 * @remarks
 * PURITY: Returns a fresh object graph each call so individual tests can shallow-clone and mutate safely.
 */
function buildFixtureDefinition(): DecisionPageDefinition {
  return {
    title: "Decision Page Fixture",
    eyebrow: "Planning And Decisions",
    lede: "Fixture used to validate the generated standalone HTML workflow.",
    summaryCards: [
      {
        title: "Primary behavior",
        body: "Every choice change copies the full chosen-token set.",
      },
      {
        title: "Fallback",
        body: "Manual copy remains visible when automatic copy is unavailable.",
      },
    ],
    storageKey: "test.decision-page",
    snapshotFileName: "fixture-state.json",
    decisions: [
      {
        id: "DECISION_SURFACE",
        title: "What should own the page?",
        statement: "Choose the first production surface.",
        blocker: true,
        recommendationAlias: "GENERATED_HTML",
        reasons: ["It keeps the first slice inspectable.", "It is sufficient for interactive testing."],
        options: [
          {
            alias: "GENERATED_HTML",
            label: "Generated standalone HTML",
            token: "CHOOSE_DECISION_DECISION_SURFACE_USE_GENERATED_STANDALONE_HTML",
            description: "Generate a static artifact from a validated decision definition.",
            pros: ["Fast to inspect.", "Easy to persist in studies or plans."],
            cons: ["Not a long-lived app shell.", "Needs a generator contract."],
          },
          {
            alias: "APP_SURFACE",
            label: "Dedicated app surface",
            token: "CHOOSE_DECISION_DECISION_SURFACE_USE_APP_SURFACE",
            description: "Use an application runtime instead of a generated page.",
            pros: ["Can become richer over time.", "Closer to a productized surface."],
            cons: ["Heavier first slice.", "More runtime ownership up front."],
          },
        ],
      },
      {
        id: "DECISION_HANDOFF",
        title: "How should handoff work?",
        statement: "Choose the default terminal handoff behavior.",
        blocker: true,
        recommendationAlias: "CLIPBOARD_ONLY",
        reasons: ["Clipboard is the shortest path back into the terminal.", "State can remain optional."],
        dependsOn: [
          {
            decisionId: "DECISION_SURFACE",
            operator: "equals",
            value: "GENERATED_HTML",
          },
        ],
        options: [
          {
            alias: "CLIPBOARD_ONLY",
            label: "Clipboard only",
            token: "CHOOSE_DECISION_DECISION_HANDOFF_USE_CLIPBOARD_ONLY",
            description: "Copy the full chosen-token set after every answer change.",
            pros: ["Simple handoff.", "No state file required."],
            cons: ["No offline snapshot unless exported.", "Less durable by default."],
            branchEffects: ["Skips persistent state unless the user downloads it."],
          },
          {
            alias: "CLIPBOARD_WITH_STATE",
            label: "Clipboard with state",
            token: "CHOOSE_DECISION_DECISION_HANDOFF_USE_CLIPBOARD_WITH_STATE",
            description: "Copy on change and support an optional JSON snapshot.",
            pros: ["Retains clipboard-first flow.", "Adds resumable JSON state."],
            cons: ["Slightly more UI surface.", "Needs snapshot formatting."],
          },
        ],
      },
    ],
  };
}

const tests: UnitTest[] = [
  {
    name: "validation accepts declarative dependencies",
    run: () => {
      const validated = validateDecisionPageDefinition(buildFixtureDefinition());
      assert.equal(validated.decisions[1]?.dependsOn?.[0]?.decisionId, "DECISION_SURFACE");
      assert.equal(validated.decisions[1]?.dependsOn?.[0]?.value, "GENERATED_HTML");
    },
  },
  {
    name: "validation rejects unknown dependency targets",
    run: () => {
      const invalid = buildFixtureDefinition();
      invalid.decisions[1] = {
        ...invalid.decisions[1],
        dependsOn: [
          {
            decisionId: "DECISION_MISSING",
            operator: "equals",
            value: "GENERATED_HTML",
          },
        ],
      };

      assert.throws(() => validateDecisionPageDefinition(invalid), /unknown decision "DECISION_MISSING"/);
    },
  },
  {
    name: "generated html contains serialized contract and copy hooks",
    run: () => {
      const html = buildHtml(buildFixtureDefinition());
      assert.match(html, /decision-page-data/);
      assert.match(html, /navigator\.clipboard/);
      assert.match(html, /CHOOSE_DECISION_DECISION_SURFACE_USE_GENERATED_STANDALONE_HTML/);
      assert.match(html, /Downloaded JSON snapshot/);
    },
  },
  {
    name: "cli writes html artifact from json input",
    run: () => {
      const workspace = createTempDir("decision-page-generator-");
      const inputPath = path.join(workspace, "definition.json");
      const outputPath = path.join(workspace, "decision-page.html");
      fs.writeFileSync(inputPath, JSON.stringify(buildFixtureDefinition(), null, 2));

      const result = spawnSync(
        "npx",
        [
          "tsx",
          "skills/decisions/scripts/generate-decision-page.ts",
          "--input",
          inputPath,
          "--output",
          outputPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.existsSync(outputPath), true);
      const html = fs.readFileSync(outputPath, "utf8");
      assert.match(html, /Decision Queue/);
      assert.match(html, /Copy now/);
      assert.match(html, /fixture-state\.json/);
    },
  },
  {
    name: "token block summary validates selected tokens and unresolved visible decisions",
    run: () => {
      const summary = summarizeSelections(
        buildFixtureDefinition(),
        [
          "Chosen decisions",
          "",
          "TOKENS",
          "CHOOSE_DECISION_DECISION_SURFACE_USE_GENERATED_STANDALONE_HTML",
        ].join("\n"),
      );

      assert.deepEqual(
        summary.answered.map((selected) => selected.option.alias),
        ["GENERATED_HTML"],
      );
      assert.deepEqual(
        summary.unanswered.map((decision) => decision.id),
        ["DECISION_HANDOFF"],
      );
    },
  },
  {
    name: "token block summary rejects conflicting options for the same decision",
    run: () => {
      assert.throws(
        () =>
          summarizeSelections(
            buildFixtureDefinition(),
            [
              "TOKENS",
              "CHOOSE_DECISION_DECISION_SURFACE_USE_GENERATED_STANDALONE_HTML",
              "CHOOSE_DECISION_DECISION_SURFACE_USE_APP_SURFACE",
            ].join("\n"),
          ),
        /multiple options for DECISION_SURFACE/,
      );
    },
  },
];

const failures = runTests(tests);
if (failures > 0) {
  process.exit(1);
}
