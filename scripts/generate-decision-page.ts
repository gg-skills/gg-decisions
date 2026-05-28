#!/usr/bin/env -S npx tsx

/**
 * @fileoverview Builds standalone interactive HTML from validated decision-page JSON definitions.
 *
 * Serializes the definition into an embedded JSON payload plus client-side state machine for
 * progressive disclosure, export, and copy helpers.
 * Flow: JSON path -> loadDecisionPageDefinition -> buildHtml -> write or dry-run preview.
 *
 * @example
 * ```bash
 * npx tsx skills/decisions/scripts/generate-decision-page.ts --input decisions.json --output page.html
 * npx tsx skills/decisions/scripts/generate-decision-page.ts --input decisions.json --output page.html --dry-run
 * ```
 *
 * @testing CLI manual: npm run file-overview-standards:target-brief -- --file skills/decisions/scripts/generate-decision-page.ts
 * @see skills/decisions/scripts/decision-page-contract.ts - Decision-page JSON contract and validation helpers consumed by the HTML generator.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */


import fs from "node:fs";
import path from "node:path";

import {
  type DecisionPageDefinition,
  loadDecisionPageDefinition,
} from "./decision-page-contract.js";

/**
 * Parsed CLI flags for the decision-page HTML generator.
 *
 * @remarks
 * Paths mirror argv until main resolves the output path for writing.
 */
type CliOptions = {
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
};

/**
 * Parses generator CLI arguments from a stripped argv slice.
 *
 * @remarks
 * Throws on unknown flags or when required --input/--output are missing.
 */
function parseArgs(argv: string[]): CliOptions {
  let inputPath = "";
  let outputPath = "";
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      inputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument "${argument}". Expected --input, --output, or --dry-run.`);
  }

  if (inputPath === "") {
    throw new Error("Missing required --input <definition.json> argument.");
  }
  if (outputPath === "") {
    throw new Error("Missing required --output <page.html> argument.");
  }

  return {
    inputPath,
    outputPath,
    dryRun,
  };
}

/**
 * Escapes text for safe insertion into HTML text nodes.
 *
 * @remarks
 * PURITY: deterministic string transform with no I/O.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Serializes a value for embedding inside HTML without breaking markup boundaries.
 *
 * @remarks
 * Escapes `<`, `>`, and `&` in the JSON text so it cannot terminate surrounding tags or scripts.
 */
function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/**
 * Builds the browser runtime script embedded in generated decision pages.
 *
 * @remarks
 * Returns JavaScript source as a string for inline `<script>` injection; not executed in Node.
 */
function buildRuntimeScript(): string {
  return String.raw`
      const rawDefinition = document.getElementById("decision-page-data");
      if (!rawDefinition) {
        throw new Error("Missing decision-page-data payload.");
      }

      const definition = JSON.parse(rawDefinition.textContent ?? "{}");
      const storageKey = definition.storageKey;

      const state = loadState();
      let activeDecisionId = getInitialActiveDecisionId();

      const heroEyebrow = document.getElementById("hero-eyebrow");
      const heroTitle = document.getElementById("hero-title");
      const heroLede = document.getElementById("hero-lede");
      const summaryRow = document.getElementById("summary-row");
      const queueRoot = document.getElementById("queue");
      const answeredCount = document.getElementById("answered-count");
      const remainingCount = document.getElementById("remaining-count");
      const activeTitle = document.getElementById("active-title");
      const activeStatus = document.getElementById("active-status");
      const activeId = document.getElementById("active-id");
      const activeStatement = document.getElementById("active-statement");
      const activeRecommendation = document.getElementById("active-recommendation");
      const activeReasons = document.getElementById("active-reasons");
      const optionGrid = document.getElementById("option-grid");
      const dependencyNote = document.getElementById("dependency-note");
      const copyStatus = document.getElementById("copy-status");
      const aliasRow = document.getElementById("alias-row");
      const exportArea = document.getElementById("export-area");
      const snapshot = document.getElementById("snapshot");
      const eventLog = document.getElementById("event-log");
      const copyButton = document.getElementById("copy-button");
      const downloadButton = document.getElementById("download-button");
      const resetButton = document.getElementById("reset-button");

      heroEyebrow.textContent = definition.eyebrow;
      heroTitle.textContent = definition.title;
      heroLede.textContent = definition.lede;

      definition.summaryCards.forEach((card) => {
        const article = document.createElement("article");
        article.className = "summary-card";
        const heading = document.createElement("h2");
        heading.textContent = card.title;
        const body = document.createElement("p");
        body.textContent = card.body;
        article.append(heading, body);
        summaryRow.append(article);
      });

      copyButton.addEventListener("click", () => {
        void copyPayload({ reason: "manual copy" });
      });

      downloadButton.addEventListener("click", () => {
        const serialized = JSON.stringify(buildSnapshot(), null, 2);
        const blob = new Blob([serialized], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = definition.snapshotFileName || "decision-page-state.json";
        anchor.click();
        URL.revokeObjectURL(url);
        pushEvent("Downloaded JSON snapshot.");
      });

      resetButton.addEventListener("click", () => {
        state.answers = {};
        state.events = [];
        persistState();
        activeDecisionId = getInitialActiveDecisionId();
        pushEvent("Reset all selected decisions.");
        render();
        void copyPayload({ reason: "reset" });
      });

      render();
      void copyPayload({ reason: "initial render" });

      function loadState() {
        const emptyState = { answers: {}, events: [] };
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
          return emptyState;
        }

        try {
          const parsed = JSON.parse(raw);
          return {
            answers: typeof parsed.answers === "object" && parsed.answers !== null ? parsed.answers : {},
            events: Array.isArray(parsed.events) ? parsed.events.slice(-12) : [],
          };
        } catch (error) {
          console.warn("Failed to parse saved decision state:", error);
          return emptyState;
        }
      }

      function persistState() {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            answers: state.answers,
            events: state.events.slice(-12),
          }),
        );
      }

      function evaluateCondition(condition) {
        const selectedAlias = state.answers[condition.decisionId];
        if (condition.operator === "equals") {
          return selectedAlias === condition.value;
        }
        if (condition.operator === "notEquals") {
          return selectedAlias !== condition.value;
        }
        if (condition.operator === "oneOf") {
          return Array.isArray(condition.values) && condition.values.includes(selectedAlias);
        }
        if (condition.operator === "notOneOf") {
          return Array.isArray(condition.values) && !condition.values.includes(selectedAlias);
        }
        return false;
      }

      function isDecisionAvailable(decision) {
        return (decision.dependsOn || []).every((condition) => evaluateCondition(condition));
      }

      function getVisibleDecisions() {
        return definition.decisions.filter((decision) => isDecisionAvailable(decision));
      }

      function getChosenOptions() {
        const chosen = [];
        for (const decision of definition.decisions) {
          const selectedAlias = state.answers[decision.id];
          if (!selectedAlias) {
            continue;
          }
          const option = decision.options.find((candidate) => candidate.alias === selectedAlias);
          if (!option) {
            continue;
          }
          chosen.push({ decision, option });
        }
        return chosen;
      }

      function buildPayload() {
        const chosen = getChosenOptions();
        const lines = ["Chosen decisions", ""];
        for (const item of chosen) {
          lines.push("- " + item.option.alias + ": " + item.decision.title);
        }
        if (chosen.length === 0) {
          lines.push("- No decisions chosen yet");
        }
        lines.push("", "TOKENS");
        for (const item of chosen) {
          lines.push(item.option.token);
        }
        return lines.join("\n");
      }

      function buildSnapshot() {
        return {
          title: definition.title,
          storageKey,
          generatedAt: new Date().toISOString(),
          answers: state.answers,
          tokens: getChosenOptions().map((item) => item.option.token),
        };
      }

      function pushEvent(message) {
        state.events.push({
          at: new Date().toISOString(),
          message,
        });
        state.events = state.events.slice(-12);
        persistState();
      }

      function ensureActiveDecision() {
        const visibleDecisions = getVisibleDecisions();
        if (visibleDecisions.length === 0) {
          activeDecisionId = definition.decisions[0]?.id || "";
          return;
        }

        if (!visibleDecisions.some((decision) => decision.id === activeDecisionId)) {
          activeDecisionId = visibleDecisions.find((decision) => !state.answers[decision.id])?.id || visibleDecisions[0].id;
        }
      }

      function invalidateUnavailableAnswers() {
        let changed = false;
        for (const decision of definition.decisions) {
          if (!state.answers[decision.id]) {
            continue;
          }
          if (isDecisionAvailable(decision)) {
            continue;
          }

          const previousAlias = state.answers[decision.id];
          delete state.answers[decision.id];
          pushEvent(
            "Invalidated " +
              decision.title +
              " because an upstream choice changed from the required branch. Removed " +
              previousAlias +
              ".",
          );
          changed = true;
        }
        return changed;
      }

      function selectOption(decisionId, alias) {
        const decision = definition.decisions.find((item) => item.id === decisionId);
        if (!decision) {
          return;
        }
        const option = decision.options.find((item) => item.alias === alias);
        if (!option) {
          return;
        }

        state.answers[decisionId] = alias;
        pushEvent("Selected " + option.alias + " for " + decision.title + ".");
        invalidateUnavailableAnswers();
        ensureActiveDecision();
        persistState();
        render();
        void copyPayload({ reason: "change to " + option.alias });
      }

      function renderQueue() {
        queueRoot.innerHTML = "";
        const visibleDecisions = getVisibleDecisions();
        const answeredVisible = visibleDecisions.filter((decision) => Boolean(state.answers[decision.id]));
        answeredCount.textContent = String(answeredVisible.length) + " answered";
        remainingCount.textContent =
          String(Math.max(visibleDecisions.length - answeredVisible.length, 0)) + " open";

        visibleDecisions.forEach((decision) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "decision-link" + (decision.id === activeDecisionId ? " active" : "");
          button.addEventListener("click", () => {
            activeDecisionId = decision.id;
            render();
          });

          const heading = document.createElement("h3");
          heading.textContent = decision.title;
          const body = document.createElement("p");
          const selectedAlias = state.answers[decision.id];
          body.textContent = selectedAlias
            ? "Answered as " + selectedAlias + ". " + decision.statement
            : decision.statement;
          button.append(heading, body);
          queueRoot.append(button);
        });
      }

      function renderActiveDecision() {
        const visibleDecisions = getVisibleDecisions();
        const activeDecision = visibleDecisions.find((decision) => decision.id === activeDecisionId) || visibleDecisions[0];
        if (!activeDecision) {
          activeTitle.textContent = "No active decisions";
          activeStatus.textContent = "Complete";
          activeId.textContent = "DONE";
          activeStatement.textContent = "All currently visible decisions are resolved.";
          activeRecommendation.textContent = "The page has no further visible decisions to present right now.";
          activeReasons.innerHTML = "";
          optionGrid.innerHTML = "";
          dependencyNote.textContent = "No dependency invalidation is currently active.";
          return;
        }

        activeDecisionId = activeDecision.id;
        activeTitle.textContent = activeDecision.title;
        activeStatus.textContent = activeDecision.blocker ? "Blocking" : "Non-blocking";
        activeId.textContent = activeDecision.id;
        activeStatement.textContent = activeDecision.statement;
        activeRecommendation.textContent = activeDecision.options.find(
          (option) => option.alias === activeDecision.recommendationAlias,
        )?.description || activeDecision.recommendationAlias;

        activeReasons.innerHTML = "";
        activeDecision.reasons.forEach((reason) => {
          const listItem = document.createElement("li");
          listItem.textContent = reason;
          activeReasons.append(listItem);
        });

        optionGrid.innerHTML = "";
        activeDecision.options.forEach((option) => {
          const card = document.createElement("article");
          const selected = state.answers[activeDecision.id] === option.alias;
          const recommended = option.alias === activeDecision.recommendationAlias;
          card.className =
            "option-card" + (selected ? " selected" : "") + (recommended ? " recommended" : "");

          const top = document.createElement("div");
          top.className = "option-top";
          const titleWrap = document.createElement("div");
          const heading = document.createElement("h3");
          heading.textContent = option.alias + ": " + option.label;
          const description = document.createElement("p");
          description.className = "option-desc";
          description.textContent = option.description;
          titleWrap.append(heading, description);

          const button = document.createElement("button");
          button.type = "button";
          button.className = "choose-button" + (recommended ? " primary" : "");
          button.textContent = selected ? "Selected" : "Choose";
          button.addEventListener("click", () => {
            selectOption(activeDecision.id, option.alias);
          });
          top.append(titleWrap, button);

          const metadata = document.createElement("div");
          metadata.className = "section";

          const prosHeading = document.createElement("h3");
          prosHeading.textContent = "Pros";
          const prosList = document.createElement("ul");
          option.pros.forEach((item) => {
            const listItem = document.createElement("li");
            listItem.textContent = item;
            prosList.append(listItem);
          });

          const consHeading = document.createElement("h3");
          consHeading.textContent = "Cons";
          const consList = document.createElement("ul");
          option.cons.forEach((item) => {
            const listItem = document.createElement("li");
            listItem.textContent = item;
            consList.append(listItem);
          });

          const token = document.createElement("div");
          token.className = "token";
          token.textContent = option.token;

          metadata.append(prosHeading, prosList, consHeading, consList, token);

          if (Array.isArray(option.branchEffects) && option.branchEffects.length > 0) {
            const branchHeading = document.createElement("h3");
            branchHeading.textContent = "Branch Effects";
            const branchList = document.createElement("ul");
            option.branchEffects.forEach((item) => {
              const listItem = document.createElement("li");
              listItem.textContent = item;
              branchList.append(listItem);
            });
            metadata.append(branchHeading, branchList);
          }

          if (option.followUp) {
            const followUp = document.createElement("p");
            followUp.className = "small";
            followUp.textContent = option.followUp;
            metadata.append(followUp);
          }

          card.append(top, metadata);
          optionGrid.append(card);
        });

        const conditionSummaries = (activeDecision.dependsOn || []).map((condition) => describeCondition(condition));
        dependencyNote.textContent =
          conditionSummaries.length > 0
            ? (activeDecision.invalidationNote ||
                "This decision remains available only while its dependency conditions stay true.") +
              " " +
              conditionSummaries.join(" ")
            : activeDecision.invalidationNote || "This decision has no upstream invalidation rules.";
      }

      function describeCondition(condition) {
        if (condition.operator === "equals") {
          return "Requires " + condition.decisionId + " = " + condition.value + ".";
        }
        if (condition.operator === "notEquals") {
          return "Requires " + condition.decisionId + " != " + condition.value + ".";
        }
        if (condition.operator === "oneOf") {
          return "Requires " + condition.decisionId + " in " + condition.values.join(", ") + ".";
        }
        return "Requires " + condition.decisionId + " not in " + condition.values.join(", ") + ".";
      }

      function renderExport() {
        const payload = buildPayload();
        exportArea.value = payload;
        aliasRow.innerHTML = "";
        getChosenOptions().forEach((item) => {
          const token = document.createElement("span");
          token.className = "token";
          token.textContent = item.option.alias;
          aliasRow.append(token);
        });
        if (!aliasRow.children.length) {
          const token = document.createElement("span");
          token.className = "token";
          token.textContent = "No choices yet";
          aliasRow.append(token);
        }

        snapshot.textContent = JSON.stringify(buildSnapshot(), null, 2);
        eventLog.innerHTML = "";
        const reversed = [...state.events].reverse();
        reversed.forEach((eventItem) => {
          const wrapper = document.createElement("div");
          wrapper.className = "event";
          const title = document.createElement("h4");
          title.textContent = new Date(eventItem.at).toLocaleString();
          const body = document.createElement("p");
          body.textContent = eventItem.message;
          wrapper.append(title, body);
          eventLog.append(wrapper);
        });
      }

      async function copyPayload({ reason }) {
        const payload = buildPayload();
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(payload);
          } else {
            exportArea.focus();
            exportArea.select();
            document.execCommand("copy");
          }
          copyStatus.textContent = "Copied all chosen tokens after " + reason + ".";
          copyStatus.className = "notice";
        } catch (error) {
          copyStatus.textContent =
            "Automatic copy failed after " +
            reason +
            ". Use Copy now or copy from the payload area manually.";
          copyStatus.className = "notice warn";
        }
      }

      function render() {
        invalidateUnavailableAnswers();
        ensureActiveDecision();
        renderQueue();
        renderActiveDecision();
        renderExport();
      }

      function getInitialActiveDecisionId() {
        const visibleDecisions = definition.decisions.filter((decision) => {
          return (decision.dependsOn || []).every((condition) => {
            if (condition.operator === "notEquals" || condition.operator === "notOneOf") {
              return true;
            }
            return state.answers[condition.decisionId] !== undefined;
          });
        });
        const firstUnanswered = visibleDecisions.find((decision) => !state.answers[decision.id]);
        return firstUnanswered?.id || visibleDecisions[0]?.id || definition.decisions[0]?.id || "";
      }
`;
}

/**
 * Emits a self-contained HTML document string for a validated `DecisionPageDefinition`.
 *
 * @remarks
 * I/O: none; output is pure string generation suitable for CLI redirection.
 * USAGE: callers must escape untrusted definition fields before additional embedding contexts.
 */
export function buildHtml(definition: DecisionPageDefinition): string {
  const serializedDefinition = escapeJsonForHtml(definition);
  const pageTitle = escapeHtml(definition.title);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle}</title>
    <style>
      :root {
        --bg: #ede8dc;
        --panel: rgba(255, 252, 244, 0.92);
        --panel-strong: #fffdf7;
        --line: #d7ceb7;
        --line-strong: #b5aa8c;
        --text: #1d2723;
        --muted: #59645d;
        --accent: #116b54;
        --accent-soft: rgba(17, 107, 84, 0.1);
        --danger: #9a3f2f;
        --danger-soft: rgba(154, 63, 47, 0.12);
        --warn: #92601c;
        --warn-soft: rgba(146, 96, 28, 0.12);
        --shadow: 0 24px 64px rgba(27, 34, 28, 0.08);
        --mono: "SFMono-Regular", "Menlo", monospace;
        --sans: "Avenir Next", "Gill Sans", sans-serif;
        --serif: "Iowan Old Style", "Palatino Linotype", serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--text);
        font-family: var(--sans);
        background:
          radial-gradient(circle at top left, rgba(17, 107, 84, 0.1), transparent 26%),
          radial-gradient(circle at top right, rgba(146, 96, 28, 0.08), transparent 32%),
          linear-gradient(180deg, #f6f2e8 0%, var(--bg) 100%);
      }

      main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 36px 22px 56px;
      }

      h1,
      h2,
      h3,
      h4,
      p {
        margin: 0;
      }

      .hero {
        display: grid;
        gap: 14px;
        margin-bottom: 24px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 7px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      h1 {
        max-width: 14ch;
        font-family: var(--serif);
        font-size: clamp(2.4rem, 4vw, 4.2rem);
        line-height: 0.95;
      }

      .lede {
        max-width: 76ch;
        color: var(--muted);
        font-size: 1.08rem;
        line-height: 1.55;
      }

      .summary-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 22px;
      }

      .summary-card,
      .panel {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }

      .summary-card {
        padding: 16px 18px;
      }

      .summary-card h2 {
        margin-bottom: 8px;
        color: var(--accent);
        font-size: 0.82rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .summary-card p {
        line-height: 1.4;
      }

      .workspace {
        display: grid;
        grid-template-columns: 0.85fr 1.3fr 1fr;
        gap: 18px;
        align-items: start;
      }

      .panel {
        overflow: hidden;
      }

      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(17, 107, 84, 0.08), transparent);
      }

      .panel-head h2 {
        font-size: 1.15rem;
      }

      .panel-body {
        padding: 18px;
      }

      .queue {
        display: grid;
        gap: 12px;
      }

      .decision-link {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 14px;
        background: var(--panel-strong);
        text-align: left;
        cursor: pointer;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .decision-link:hover {
        transform: translateY(-1px);
        border-color: var(--line-strong);
      }

      .decision-link.active {
        border-color: rgba(17, 107, 84, 0.34);
        background: linear-gradient(180deg, rgba(17, 107, 84, 0.12), rgba(17, 107, 84, 0.05));
      }

      .decision-link h3 {
        font-size: 1rem;
        margin-bottom: 6px;
      }

      .decision-link p {
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.4;
      }

      .pill-row,
      .token-row,
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .pill,
      .token,
      .action {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 12px;
        background: var(--panel-strong);
      }

      .pill,
      .action {
        font-size: 0.92rem;
      }

      .token {
        font-family: var(--mono);
        font-size: 0.82rem;
        overflow-wrap: anywhere;
      }

      .option-grid {
        display: grid;
        gap: 12px;
        margin-top: 18px;
      }

      .option-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        background: var(--panel-strong);
      }

      .option-card.selected {
        border-color: rgba(17, 107, 84, 0.34);
        box-shadow: inset 0 0 0 1px rgba(17, 107, 84, 0.18);
      }

      .option-card.recommended {
        background: linear-gradient(180deg, rgba(17, 107, 84, 0.09), rgba(17, 107, 84, 0.03));
      }

      .option-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 14px;
        margin-bottom: 10px;
      }

      .option-top h3 {
        font-size: 1rem;
      }

      .option-desc {
        color: var(--muted);
        line-height: 1.5;
        margin-top: 6px;
      }

      .choose-button,
      .secondary-button {
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }

      .choose-button.primary {
        border-color: rgba(17, 107, 84, 0.42);
        background: rgba(17, 107, 84, 0.08);
        color: var(--accent);
      }

      .secondary-button {
        background: var(--panel-strong);
      }

      .section {
        display: grid;
        gap: 10px;
        margin-bottom: 18px;
      }

      .section h3 {
        font-size: 0.92rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }

      .section p,
      .section li {
        color: var(--muted);
        line-height: 1.5;
      }

      ul {
        margin: 0;
        padding-left: 20px;
      }

      .export-area {
        width: 100%;
        min-height: 230px;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        resize: vertical;
        font: 0.88rem/1.45 var(--mono);
        color: var(--text);
        background: var(--panel-strong);
      }

      .snapshot {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        background: var(--panel-strong);
        font: 0.82rem/1.45 var(--mono);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .event-log {
        display: grid;
        gap: 10px;
        margin-top: 14px;
      }

      .event {
        border-left: 3px solid var(--line-strong);
        padding-left: 12px;
      }

      .event p {
        color: var(--muted);
      }

      .notice {
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        line-height: 1.45;
      }

      .notice.warn {
        border-color: rgba(146, 96, 28, 0.25);
        background: var(--warn-soft);
      }

      .sticky {
        position: sticky;
        top: 20px;
      }

      .small {
        font-size: 0.92rem;
        color: var(--muted);
      }

      @media (max-width: 1180px) {
        .summary-row {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .workspace {
          grid-template-columns: 1fr;
        }

        .sticky {
          position: static;
        }
      }

      @media (max-width: 680px) {
        .summary-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow" id="hero-eyebrow"></div>
        <h1 id="hero-title"></h1>
        <p class="lede" id="hero-lede"></p>
      </section>

      <section class="summary-row" id="summary-row"></section>

      <section class="workspace">
        <aside class="panel">
          <div class="panel-head">
            <h2>Decision Queue</h2>
            <div class="pill-row">
              <span class="pill" id="answered-count">0 answered</span>
              <span class="pill" id="remaining-count">0 open</span>
            </div>
          </div>
          <div class="panel-body queue" id="queue"></div>
        </aside>

        <section class="panel">
          <div class="panel-head">
            <h2 id="active-title">Decision</h2>
            <div class="pill-row">
              <span class="pill" id="active-status">Blocking</span>
              <span class="pill" id="active-id">Decision ID</span>
            </div>
          </div>
          <div class="panel-body">
            <div class="section">
              <h3>Decision Snapshot</h3>
              <p id="active-statement"></p>
            </div>

            <div class="section">
              <h3>Recommendation</h3>
              <div class="notice" id="active-recommendation"></div>
            </div>

            <div class="section">
              <h3>Why This Matters</h3>
              <ul id="active-reasons"></ul>
            </div>

            <div class="section">
              <h3>Viable Options</h3>
              <div class="option-grid" id="option-grid"></div>
            </div>

            <div class="section">
              <h3>Branch Effects</h3>
              <div class="notice warn" id="dependency-note"></div>
            </div>
          </div>
        </section>

        <aside class="panel sticky">
          <div class="panel-head">
            <h2>Live Export</h2>
            <div class="button-row">
              <button class="secondary-button" id="copy-button" type="button">Copy now</button>
              <button class="secondary-button" id="download-button" type="button">Download state</button>
              <button class="secondary-button" id="reset-button" type="button">Reset</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="section">
              <h3>Copy Status</h3>
              <div class="notice" id="copy-status"></div>
            </div>

            <div class="section">
              <h3>Current Answer Aliases</h3>
              <div class="token-row" id="alias-row"></div>
            </div>

            <div class="section">
              <h3>Clipboard Payload</h3>
              <textarea class="export-area" id="export-area" readonly></textarea>
            </div>

            <div class="section">
              <h3>Optional State Snapshot</h3>
              <div class="snapshot" id="snapshot"></div>
            </div>

            <div class="section">
              <h3>Event Log</h3>
              <div class="event-log" id="event-log"></div>
            </div>
          </div>
        </aside>
      </section>
    </main>

    <script type="application/json" id="decision-page-data">${serializedDefinition}</script>
    <script>${buildRuntimeScript()}</script>
  </body>
</html>
`;
}

/**
 * Writes generated HTML to disk, creating parent directories as needed.
 *
 * @remarks
 * I/O: synchronous filesystem write under outputPath.
 */
function writeHtml(outputPath: string, html: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);
}

/**
 * CLI entry: loads definition, builds HTML, optionally writes output, logs status.
 *
 * @remarks
 * Dry-run validates and resolves paths without writing the HTML file.
 */
function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const definition = loadDecisionPageDefinition(options.inputPath);
  const html = buildHtml(definition);
  const absoluteOutputPath = path.resolve(options.outputPath);

  if (!options.dryRun) {
    writeHtml(absoluteOutputPath, html);
  }

  console.log(
    `${options.dryRun ? "Validated" : "Generated"} decision page from ${path.resolve(options.inputPath)} -> ${absoluteOutputPath}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
