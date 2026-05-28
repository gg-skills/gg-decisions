#!/usr/bin/env -S npx tsx

/**
 * @fileoverview Decision-page contract types and validation helpers for workflow decision tooling.
 *
 * This file owns the canonical type shape and runtime validation for decision-page JSON definitions
 * consumed by the Notion decision-tracking surface.
 * Flow: JSON file -> loadDecisionPageDefinition -> validateDecisionPageDefinition -> typed definition.
 *
 * @example
 * ```typescript
 * const definition = loadDecisionPageDefinition("./decision-page.json");
 * ```
 *
 * @testing CLI: rerun `npm run file-overview-standards:target-brief -- --file skills/decisions/scripts/decision-page-contract.ts` from the repo root after editing this file.
 * @see skills/decisions/scripts/decision-page-session.ts - Session helper that consumes this contract when rewriting decision markdown and task bodies.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Supported comparison operators for `dependsOn` decision gating.
 *
 * @remarks
 * `oneOf` / `notOneOf` require `values`; scalar operators use `value`.
 */
export type DecisionPageConditionOperator =
  | "equals"
  | "notEquals"
  | "oneOf"
  | "notOneOf";

/**
 * Declares when a decision becomes selectable based on earlier answers.
 */
export type DecisionPageCondition = {
  decisionId: string;
  operator: DecisionPageConditionOperator;
  value?: string;
  values?: string[];
};

/**
 * Compact card rendered in the HTML summary grid.
 */
export type DecisionPageSummaryCard = {
  title: string;
  body: string;
};

/**
 * Selectable option metadata including tradeoff lists and optional branch notes.
 */
export type DecisionPageOption = {
  alias: string;
  label: string;
  token: string;
  description: string;
  pros: string[];
  cons: string[];
  branchEffects?: string[];
  followUp?: string;
};

/**
 * Single decision block with recommendation, rationale, and dependency graph.
 */
export type DecisionPageDecision = {
  id: string;
  title: string;
  statement: string;
  blocker: boolean;
  recommendationAlias: string;
  reasons: string[];
  invalidationNote?: string;
  dependsOn?: DecisionPageCondition[];
  options: DecisionPageOption[];
};

/**
 * Top-level JSON contract for a decision page, including copy and decision list.
 */
export type DecisionPageDefinition = {
  title: string;
  eyebrow: string;
  lede: string;
  summaryCards: DecisionPageSummaryCard[];
  storageKey: string;
  snapshotFileName?: string;
  decisions: DecisionPageDecision[];
};

/**
 * Throws a validation failure for the current JSON path.
 *
 * @remarks
 * Central exit for contract violations so callers see consistent, path-qualified messages.
 *
 * @param message - Failure detail including the offending field path when applicable.
 */
function fail(message: string): never {
  throw new Error(message);
}

/**
 * Narrows a JSON value to a plain object record (excludes arrays and null).
 *
 * @param value - Parsed JSON subtree to inspect.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Requires a non-empty trimmed string at the given JSON path.
 *
 * @param value - Parsed JSON value for the field.
 * @param fieldPath - Dot/bracket path label included in failure messages.
 */
function expectString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${fieldPath} must be a non-empty string.`);
  }
  return value;
}

/**
 * Requires a boolean at the given JSON path.
 *
 * @param value - Parsed JSON value for the field.
 * @param fieldPath - Dot/bracket path label included in failure messages.
 */
function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${fieldPath} must be a boolean.`);
  }
  return value;
}

/**
 * Requires a non-empty array whose elements are non-empty strings.
 *
 * @param value - Parsed JSON value for the array field.
 * @param fieldPath - Dot/bracket path label included in failure messages.
 */
function expectStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${fieldPath} must be a non-empty string array.`);
  }

  return value.map((item, index) =>
    expectString(item, `${fieldPath}[${index}]`),
  );
}

/**
 * Validates one `summaryCards` entry object.
 *
 * @param value - Parsed JSON element at `summaryCards[index]`.
 * @param index - Zero-based index used only for error messages.
 */
function validateSummaryCard(
  value: unknown,
  index: number,
): DecisionPageSummaryCard {
  if (!isRecord(value)) {
    fail(`summaryCards[${index}] must be an object.`);
  }

  return {
    title: expectString(value.title, `summaryCards[${index}].title`),
    body: expectString(value.body, `summaryCards[${index}].body`),
  };
}

/**
 * Validates one option object nested under `decisions[decisionIndex].options`.
 *
 * @param value - Parsed JSON option subtree.
 * @param decisionIndex - Parent decision index for path-qualified errors.
 * @param optionIndex - Option index within the parent decision for path-qualified errors.
 */
function validateOption(
  value: unknown,
  decisionIndex: number,
  optionIndex: number,
): DecisionPageOption {
  if (!isRecord(value)) {
    fail(
      `decisions[${decisionIndex}].options[${optionIndex}] must be an object.`,
    );
  }

  const optionPath = `decisions[${decisionIndex}].options[${optionIndex}]`;
  const branchEffects =
    value.branchEffects === undefined
      ? undefined
      : expectStringArray(value.branchEffects, `${optionPath}.branchEffects`);
  const followUp =
    value.followUp === undefined
      ? undefined
      : expectString(value.followUp, `${optionPath}.followUp`);

  return {
    alias: expectString(value.alias, `${optionPath}.alias`),
    label: expectString(value.label, `${optionPath}.label`),
    token: expectString(value.token, `${optionPath}.token`),
    description: expectString(value.description, `${optionPath}.description`),
    pros: expectStringArray(value.pros, `${optionPath}.pros`),
    cons: expectStringArray(value.cons, `${optionPath}.cons`),
    branchEffects,
    followUp,
  };
}

/**
 * Validates a single `dependsOn` condition, including operator-specific value shapes.
 *
 * @remarks
 * Scalar operators require `value` and forbid `values`; set operators require `values` and forbid `value`.
 *
 * @param value - Parsed JSON condition subtree.
 * @param decisionIndex - Parent decision index for path-qualified errors.
 * @param conditionIndex - Condition index within `dependsOn` for path-qualified errors.
 */
function validateCondition(
  value: unknown,
  decisionIndex: number,
  conditionIndex: number,
): DecisionPageCondition {
  if (!isRecord(value)) {
    fail(
      `decisions[${decisionIndex}].dependsOn[${conditionIndex}] must be an object.`,
    );
  }

  const conditionPath = `decisions[${decisionIndex}].dependsOn[${conditionIndex}]`;
  const operator = expectString(value.operator, `${conditionPath}.operator`);
  if (
    operator !== "equals" &&
    operator !== "notEquals" &&
    operator !== "oneOf" &&
    operator !== "notOneOf"
  ) {
    fail(
      `${conditionPath}.operator must be one of equals, notEquals, oneOf, notOneOf.`,
    );
  }

  if (operator === "equals" || operator === "notEquals") {
    if (value.values !== undefined) {
      fail(
        `${conditionPath}.values is not valid when operator is ${operator}.`,
      );
    }

    return {
      decisionId: expectString(value.decisionId, `${conditionPath}.decisionId`),
      operator,
      value: expectString(value.value, `${conditionPath}.value`),
    };
  }

  if (value.value !== undefined) {
    fail(`${conditionPath}.value is not valid when operator is ${operator}.`);
  }

  return {
    decisionId: expectString(value.decisionId, `${conditionPath}.decisionId`),
    operator,
    values: expectStringArray(value.values, `${conditionPath}.values`),
  };
}

/**
 * Validates one decision block including nested options and optional `dependsOn`.
 *
 * @param value - Parsed JSON decision subtree.
 * @param index - Zero-based decision index for path-qualified errors.
 */
function validateDecision(value: unknown, index: number): DecisionPageDecision {
  if (!isRecord(value)) {
    fail(`decisions[${index}] must be an object.`);
  }

  const decisionPath = `decisions[${index}]`;
  const dependsOn =
    value.dependsOn === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.dependsOn) || value.dependsOn.length === 0) {
            fail(
              `${decisionPath}.dependsOn must be a non-empty array when present.`,
            );
          }
          return value.dependsOn.map((condition, conditionIndex) =>
            validateCondition(condition, index, conditionIndex),
          );
        })();

  if (!Array.isArray(value.options) || value.options.length === 0) {
    fail(`${decisionPath}.options must be a non-empty array.`);
  }

  return {
    id: expectString(value.id, `${decisionPath}.id`),
    title: expectString(value.title, `${decisionPath}.title`),
    statement: expectString(value.statement, `${decisionPath}.statement`),
    blocker: expectBoolean(value.blocker, `${decisionPath}.blocker`),
    recommendationAlias: expectString(
      value.recommendationAlias,
      `${decisionPath}.recommendationAlias`,
    ),
    reasons: expectStringArray(value.reasons, `${decisionPath}.reasons`),
    invalidationNote:
      value.invalidationNote === undefined
        ? undefined
        : expectString(
            value.invalidationNote,
            `${decisionPath}.invalidationNote`,
          ),
    dependsOn,
    options: value.options.map((option, optionIndex) =>
      validateOption(option, index, optionIndex),
    ),
  };
}

/**
 * First pass for cross-reference validation: unique decision ids, per-decision unique aliases,
 * globally unique option tokens, and recommendationAlias membership.
 *
 * @remarks
 * Mutates nothing; throws via `fail` on the first violation.
 *
 * @param decisions - Fully shaped decisions from per-field validators.
 * @returns Registry state used by the dependsOn pass.
 */
function buildCrossReferenceRegistry(decisions: DecisionPageDecision[]): {
  knownDecisionIds: Set<string>;
  optionsByDecisionId: Map<string, Set<string>>;
} {
  const knownDecisionIds = new Set<string>();
  const optionsByDecisionId = new Map<string, Set<string>>();
  const knownTokens = new Set<string>();

  for (const decision of decisions) {
    if (knownDecisionIds.has(decision.id)) {
      fail(`Duplicate decision id "${decision.id}" is not allowed.`);
    }
    knownDecisionIds.add(decision.id);

    const optionAliases = new Set<string>();
    for (const option of decision.options) {
      if (optionAliases.has(option.alias)) {
        fail(
          `Decision "${decision.id}" contains duplicate option alias "${option.alias}".`,
        );
      }
      if (knownTokens.has(option.token)) {
        fail(`Duplicate option token "${option.token}" is not allowed.`);
      }
      optionAliases.add(option.alias);
      knownTokens.add(option.token);
    }

    if (!optionAliases.has(decision.recommendationAlias)) {
      fail(
        `Decision "${decision.id}" recommendationAlias "${decision.recommendationAlias}" does not match any option alias.`,
      );
    }

    optionsByDecisionId.set(decision.id, optionAliases);
  }

  return { knownDecisionIds, optionsByDecisionId };
}

/**
 * Second pass for cross-reference validation: dependsOn targets exist, appear after definition,
 * and reference valid option aliases for scalar or set operators.
 *
 * @remarks
 * Mutates nothing; throws via `fail` on the first violation.
 *
 * @param decisions - Fully shaped decisions from per-field validators.
 * @param knownDecisionIds - Decision ids observed in definition order during the first pass.
 * @param optionsByDecisionId - Option aliases keyed by decision id from the first pass.
 */
function assertDependsOnReferencesValid(
  decisions: DecisionPageDecision[],
  knownDecisionIds: Set<string>,
  optionsByDecisionId: Map<string, Set<string>>,
): void {
  for (const decision of decisions) {
    for (const condition of decision.dependsOn ?? []) {
      if (!knownDecisionIds.has(condition.decisionId)) {
        fail(
          `Decision "${decision.id}" depends on unknown decision "${condition.decisionId}".`,
        );
      }

      const validAliases = optionsByDecisionId.get(condition.decisionId);
      if (!validAliases) {
        fail(
          `Decision "${decision.id}" depends on decision "${condition.decisionId}" before it is defined.`,
        );
      }

      const aliasesToCheck =
        condition.value === undefined
          ? (condition.values ?? [])
          : [condition.value];
      for (const alias of aliasesToCheck) {
        if (!validAliases.has(alias)) {
          fail(
            `Decision "${decision.id}" dependency on "${condition.decisionId}" references unknown alias "${alias}".`,
          );
        }
      }
    }
  }
}

/**
 * Enforces cross-reference constraints after the definition shape is validated.
 *
 * @remarks
 * Mutates nothing; throws via `fail` on the first violation. Order matches prior inline validation.
 *
 * @param definition - Fully shaped definition from per-field validators.
 */
function validateDecisionPageCrossReferences(
  definition: DecisionPageDefinition,
): void {
  const { knownDecisionIds, optionsByDecisionId } = buildCrossReferenceRegistry(
    definition.decisions,
  );
  assertDependsOnReferencesValid(
    definition.decisions,
    knownDecisionIds,
    optionsByDecisionId,
  );
}

/**
 * Validates a raw unknown value as a DecisionPageDefinition.
 * Throws descriptive errors on the first validation failure.
 * Performs cross-reference validation: unique decision IDs, unique option aliases, unique tokens,
 * valid recommendationAlias references, and valid dependsOn chains.
 *
 * @param value - Raw JSON-parsed object to validate.
 * @returns Validated definition with all cross-reference constraints satisfied.
 * @throws Error with descriptive message on any validation failure.
 */
export function validateDecisionPageDefinition(
  value: unknown,
): DecisionPageDefinition {
  if (!isRecord(value)) {
    fail("Decision page definition must be an object.");
  }

  if (!Array.isArray(value.summaryCards) || value.summaryCards.length === 0) {
    fail("summaryCards must be a non-empty array.");
  }
  if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
    fail("decisions must be a non-empty array.");
  }

  const definition: DecisionPageDefinition = {
    title: expectString(value.title, "title"),
    eyebrow: expectString(value.eyebrow, "eyebrow"),
    lede: expectString(value.lede, "lede"),
    summaryCards: value.summaryCards.map((card, index) =>
      validateSummaryCard(card, index),
    ),
    storageKey: expectString(value.storageKey, "storageKey"),
    snapshotFileName:
      value.snapshotFileName === undefined
        ? undefined
        : expectString(value.snapshotFileName, "snapshotFileName"),
    decisions: value.decisions.map((decision, index) =>
      validateDecision(decision, index),
    ),
  };

  validateDecisionPageCrossReferences(definition);

  return definition;
}

/**
 * Loads a decision-page definition from a JSON file and validates it.
 *
 * @param inputPath - Absolute or relative path to the JSON definition file.
 * @returns Validated definition loaded from the given path.
 * @throws Error if the file cannot be read or validation fails.
 */
export function loadDecisionPageDefinition(
  inputPath: string,
): DecisionPageDefinition {
  const absoluteInputPath = path.resolve(inputPath);
  const raw = fs.readFileSync(absoluteInputPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return validateDecisionPageDefinition(parsed);
}
