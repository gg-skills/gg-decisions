#!/usr/bin/env -S npx tsx

/**
 * @fileoverview Bridges decision-page JSON definitions into local decision-page markdown workflows.
 *
 * Owns prepare/summarize/sync subcommands that rewrite plan markdown using canonical decision
 * tokens and HTML exports.
 * Flow: definition + token block -> summarizeSelections -> markdown/HTML artifacts; optional `--execute` applies writes.
 *
 * @example
 * ```bash
 * npx tsx skills/decisions/scripts/decision-page-session.ts prepare --definition-file decisions.json --output-dir ./out
 * npx tsx skills/decisions/scripts/decision-page-session.ts summarize-token-block --definition-file decisions.json --tokens-file tokens.txt
 * npx tsx skills/decisions/scripts/decision-page-session.ts sync-plan --definition-file decisions.json --tokens-file tokens.txt --plan-file plan.md --execute
 * ```
 *
 * @testing CLI manual: npm run file-overview-standards:target-brief -- --file skills/decisions/scripts/decision-page-session.ts
 * @see skills/decisions/references/decision-page-json-contract.md - Clipboard payload and sync-plan contracts.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */


import fs from "node:fs";
import path from "node:path";

import {
  type DecisionPageDecision,
  type DecisionPageDefinition,
  type DecisionPageOption,
  loadDecisionPageDefinition,
} from "./decision-page-contract.js";
import { buildHtml } from "./generate-decision-page.js";

/**
 * Parsed CLI invocation: optional command token plus `--key` / `--key value` flags.
 */
type ParsedArgs = {
  command: string | null;
  options: Map<string, string | boolean>;
};

/**
 * One resolved choice: a definition decision paired with its selected option record.
 */
type SelectedDecision = {
  decision: DecisionPageDecision;
  option: DecisionPageOption;
};

/**
 * Result of correlating tokens with the definition: resolved picks and still-open decisions.
 */
type DecisionSelectionSummary = {
  answered: SelectedDecision[];
  unanswered: DecisionPageDecision[];
};

/**
 * Parses process argv after the script name into a command and flag map.
 *
 * @remarks
 * Positional arguments beyond the first command token throw.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string | boolean>();
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current.startsWith("--")) {
      const key = current.slice(2);
      const next = argv[index + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        options.set(key, next);
        index += 1;
        continue;
      }
      options.set(key, true);
      continue;
    }

    if (command === null) {
      command = current;
      continue;
    }

    throw new Error(`Unexpected positional argument: ${current}`);
  }

  return { command, options };
}

/**
 * Reads a `--key` flag value as a string when present.
 *
 * @throws Error when `required` is true and the flag is missing or not a string value.
 */
function getStringOption(options: Map<string, string | boolean>, key: string, required = false): string | undefined {
  const value = options.get(key);
  if (typeof value === "string") {
    return value;
  }

  if (required) {
    throw new Error(`Missing required option --${key}`);
  }

  return undefined;
}

/**
 * True when the flag was passed as a boolean switch (`--flag` with no following value).
 */
function getBooleanOption(options: Map<string, string | boolean>, key: string): boolean {
  return options.get(key) === true;
}

/**
 * Prints supported subcommands and example invocations to stdout.
 */
function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx skills/decisions/scripts/decision-page-session.ts prepare --definition-file <path> --output-dir <dir>",
      "  npx tsx skills/decisions/scripts/decision-page-session.ts summarize-token-block --definition-file <path> --tokens-file <path>",
      "  npx tsx skills/decisions/scripts/decision-page-session.ts sync-plan --definition-file <path> --tokens-file <path> --plan-file <path> [--execute]",
    ].join("\n"),
  );
}

/**
 * Reads a UTF-8 text file from a path resolved against the current working directory.
 */
function readTextFile(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

/**
 * Ensures parent directories exist, then writes UTF-8 text to the resolved path.
 */
function writeTextFile(filePath: string, content: string): void {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

/**
 * Extracts unique `CHOOSE_DECISION_*` token lines from free-form text (order preserved).
 */
function extractCanonicalTokens(rawText: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^CHOOSE_DECISION_[A-Z0-9_]+$/.test(trimmed)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tokens.push(trimmed);
  }
  return tokens;
}

/**
 * Whether `decision` is eligible given upstream alias selections per `dependsOn` rules.
 */
function evaluateDecisionAvailability(
  decision: DecisionPageDecision,
  selectedAliases: Map<string, string>,
): boolean {
  return (decision.dependsOn ?? []).every((condition) => {
    const selectedAlias = selectedAliases.get(condition.decisionId);
    if (condition.operator === "equals") {
      return selectedAlias === condition.value;
    }
    if (condition.operator === "notEquals") {
      return selectedAlias !== condition.value;
    }
    if (condition.operator === "oneOf") {
      return Array.isArray(condition.values) && condition.values.includes(selectedAlias ?? "");
    }
    return Array.isArray(condition.values) && !condition.values.includes(selectedAlias ?? "");
  });
}

/**
 * Correlates canonical `CHOOSE_DECISION_*` tokens with a loaded definition and dependency rules.
 *
 * @remarks
 * PRE-CONDITION: `rawTokenBlock` must contain at least one canonical token line.
 * POST-CONDITION: returns answered selections plus any decisions still awaiting tokens.
 * @throws Error when tokens are missing, unknown, duplicated per decision, or violate `dependsOn`.
 */
export function summarizeSelections(
  definition: DecisionPageDefinition,
  rawTokenBlock: string,
): DecisionSelectionSummary {
  const tokens = extractCanonicalTokens(rawTokenBlock);
  if (tokens.length === 0) {
    throw new Error("No canonical decision tokens were found in the provided token block.");
  }

  const optionByToken = new Map<string, SelectedDecision>();
  for (const decision of definition.decisions) {
    for (const option of decision.options) {
      optionByToken.set(option.token, { decision, option });
    }
  }

  const selectedAliases = new Map<string, string>();
  const answered: SelectedDecision[] = [];

  for (const token of tokens) {
    const selected = optionByToken.get(token);
    if (!selected) {
      throw new Error(`Unknown decision token "${token}" does not exist in the definition.`);
    }

    const existingAlias = selectedAliases.get(selected.decision.id);
    if (existingAlias && existingAlias !== selected.option.alias) {
      throw new Error(
        `Token block selects multiple options for ${selected.decision.id}: ${existingAlias} and ${selected.option.alias}.`,
      );
    }

    if (!existingAlias) {
      selectedAliases.set(selected.decision.id, selected.option.alias);
      answered.push(selected);
    }
  }

  for (const selected of answered) {
    if (!evaluateDecisionAvailability(selected.decision, selectedAliases)) {
      throw new Error(
        `Selected option ${selected.option.alias} for ${selected.decision.id} is incompatible with the current upstream choices.`,
      );
    }
  }

  const unanswered = definition.decisions.filter((decision) => {
    if (!evaluateDecisionAvailability(decision, selectedAliases)) {
      return false;
    }
    return !selectedAliases.has(decision.id);
  });

  return {
    answered,
    unanswered,
  };
}

/**
 * Markdown fragment listing answered decisions for the plan file's answered-decisions section.
 */
function renderPlanAnsweredDecisions(answered: SelectedDecision[]): string {
  if (answered.length === 0) {
    return "No answered decisions have been applied from the decision page yet.";
  }

  return answered
    .map((selected, index) =>
      [
        `${index + 1}. \`${selected.decision.id}\``,
        "   - Status: answered",
        `   - Answer: \`${selected.option.alias}\``,
        `   - Canonical token: \`${selected.option.token}\``,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Truncates markdown to the first 40 lines for CLI JSON preview payloads.
 */
function previewMarkdown(markdown: string): string {
  return markdown.split("\n").slice(0, 40).join("\n");
}


/**
 * Builds a markdown heading line at the requested depth.
 */
function buildHeading(title: string, depth: number): string {
  return `${"#".repeat(depth)} ${title}`;
}

/**
 * Finds a heading with exact text at the requested depth.
 */
function findHeadingIndex(lines: string[], title: string, depth: number): number {
  const marker = `${"#".repeat(depth)} `;
  const normalizedTitle = title.trim().toLowerCase();
  return lines.findIndex(
    (line) => line.startsWith(marker) && line.slice(marker.length).trim().toLowerCase() === normalizedTitle,
  );
}

/**
 * Finds the first following heading that closes the current section.
 */
function findSectionEnd(lines: string[], startIndex: number, depth: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^(#{1,6})\s+/.exec(line);
    const marker = match?.[1];
    if (marker && marker.length <= depth) {
      return index;
    }
  }

  return lines.length;
}

/**
 * Upserts a third-level child section under a second-level parent heading.
 */
function upsertMarkdownSection(markdown: string, sectionPath: readonly [string, string], content: string): string {
  const [parentTitle, childTitle] = sectionPath;
  const lines = markdown.split(/\r?\n/);
  const parentIndex = findHeadingIndex(lines, parentTitle, 2);
  const replacement = [buildHeading(childTitle, 3), "", content.trim(), ""];

  if (parentIndex === -1) {
    const addition = [buildHeading(parentTitle, 2), "", ...replacement].join("\n");
    const existing = markdown.trimEnd();
    return existing.length > 0 ? `${existing}\n\n${addition}` : addition;
  }

  const parentEndIndex = findSectionEnd(lines, parentIndex, 2);
  const childLines = lines.slice(parentIndex + 1, parentEndIndex);
  const childRelativeIndex = findHeadingIndex(childLines, childTitle, 3);

  if (childRelativeIndex === -1) {
    lines.splice(parentEndIndex, 0, "", ...replacement);
    return lines.join("\n");
  }

  const childIndex = parentIndex + 1 + childRelativeIndex;
  const childEndIndex = findSectionEnd(lines, childIndex, 3);
  lines.splice(childIndex, childEndIndex - childIndex, ...replacement);
  return lines.join("\n");
}

/**
 * `prepare` subcommand: materializes definition JSON and rendered HTML under `--output-dir`.
 */
async function handlePrepare(options: Map<string, string | boolean>): Promise<void> {
  const definitionFile = getStringOption(options, "definition-file", true)!;
  const outputDir = path.resolve(getStringOption(options, "output-dir", true)!);
  const definition = loadDecisionPageDefinition(definitionFile);
  const html = buildHtml(definition);

  const definitionOutputPath = path.join(outputDir, "definition.json");
  const htmlOutputPath = path.join(outputDir, "index.html");

  writeTextFile(definitionOutputPath, JSON.stringify(definition, null, 2));
  writeTextFile(htmlOutputPath, html);

  console.log(
    JSON.stringify(
      {
        definitionFile: definitionOutputPath,
        htmlFile: htmlOutputPath,
        outputDir,
        title: definition.title,
      },
      null,
      2,
    ),
  );
}

/**
 * `summarize-token-block` subcommand: prints answered option metadata and unanswered decision IDs.
 */
async function handleSummarize(options: Map<string, string | boolean>): Promise<void> {
  const definition = loadDecisionPageDefinition(getStringOption(options, "definition-file", true)!);
  const tokenBlock = readTextFile(getStringOption(options, "tokens-file", true)!);
  const summary = summarizeSelections(definition, tokenBlock);
  console.log(
    JSON.stringify(
      {
        answered: summary.answered.map((selected) => ({
          alias: selected.option.alias,
          decisionId: selected.decision.id,
          token: selected.option.token,
        })),
        unansweredDecisionIds: summary.unanswered.map((decision) => decision.id),
      },
      null,
      2,
    ),
  );
}

/**
 * `sync-plan` subcommand: updates plan markdown sections from tokens; writes when `--execute` is set.
 */
async function handleSyncPlan(options: Map<string, string | boolean>): Promise<void> {
  const definition = loadDecisionPageDefinition(getStringOption(options, "definition-file", true)!);
  const tokenBlock = readTextFile(getStringOption(options, "tokens-file", true)!);
  const planFile = path.resolve(getStringOption(options, "plan-file", true)!);
  const execute = getBooleanOption(options, "execute");
  const summary = summarizeSelections(definition, tokenBlock);
  const originalMarkdown = readTextFile(planFile);
  const nextMarkdown = upsertMarkdownSection(
    originalMarkdown,
    ["Decision Register", "Answered Decisions"],
    renderPlanAnsweredDecisions(summary.answered),
  );

  if (execute) {
    writeTextFile(planFile, `${nextMarkdown.trim()}\n`);
  }

  console.log(
    JSON.stringify(
      {
        execute,
        planFile,
        preview: previewMarkdown(nextMarkdown),
        unansweredDecisionIds: summary.unanswered.map((decision) => decision.id),
        updated: execute,
      },
      null,
      2,
    ),
  );
}

/**
 * CLI entrypoint: routes to prepare, summarize, or sync-plan; prints usage for help.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === null || parsed.command === "--help" || parsed.command === "help") {
    printUsage();
    return;
  }

  if (parsed.command === "prepare") {
    await handlePrepare(parsed.options);
    return;
  }

  if (parsed.command === "summarize-token-block") {
    await handleSummarize(parsed.options);
    return;
  }

  if (parsed.command === "sync-plan") {
    await handleSyncPlan(parsed.options);
    return;
  }


  throw new Error(`Unknown command "${parsed.command}".`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
