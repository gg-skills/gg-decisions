#!/usr/bin/env npx tsx

/**
 * @fileoverview CLI entrypoint that scores decision markdown packets against the 14-item Decision
 * Quality Checklist and prints a human-readable completeness report or JSON for automation.
 *
 * This file owns argv parsing, latest-packet discovery under `.tmp/decisions/`, markdown
 * heuristics for metadata and checklist rows, weighted scoring, and the presentability gate.
 * Flow: argv -> resolve packet path (`--packet` or newest `decision-*.md` under `.tmp/decisions/<run>/`) -> read file -> extract metadata -> evaluate checklist -> stdout (and `process.exit(1)` on read errors).
 *
 * @testing CLI: npx tsx skills/decisions/scripts/check-decision-completeness.ts --packet <path-to-decision-packet.md> [--json] (from repository root; inspect checklist lines, score, and Presentable line in stdout, or validate JSON shape when `--json` is set).
 * @testing CLI: npx tsx skills/decisions/scripts/check-decision-completeness.ts --latest [--json] (from repository root after a decisions run materialized `.tmp/decisions/<run>/decision-*.md`; confirm the script resolves the newest run directory and emits the same report fields as the explicit `--packet` path).
 *
 * @see skills/decisions/SKILL.md - Canonical decisions skill that defines how decision packets are authored and where this completeness gate fits before presentation.
 * @see skills/decisions/references/decision-presentation-contract.md - Markdown presentation contract and checklist-oriented expectations that align with the regex probes in this script.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview documentation standard applied to this repository, including the audited `@testing` / `@see` / `@documentation` tag contract.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { argv } from "process";

// ============================================================================
// Types
// ============================================================================

/**
 * One row in the 14-item decision quality checklist used for weighted scoring.
 *
 * @remarks
 * Template definitions omit `checked`; runtime evaluation merges in results from {@link checkItem}.
 */
interface ChecklistItem {
  number: number;
  name: string;
  description: string;
  required: boolean;
  checked: boolean;
  weight: number;
}

/**
 * Parsed header fields for a decision markdown packet surfaced in reports and CLI output.
 *
 * @remarks
 * `path` is initially a placeholder until the caller assigns the resolved packet filesystem path.
 */
interface DecisionMetadata {
  title: string;
  path: string;
  id: string;
  status: string;
  tier: string;
}

/**
 * Aggregated checklist outcome, score, tier label, and presentability gate for one packet.
 */
interface CompletenessReport {
  metadata: DecisionMetadata;
  checklist: ChecklistItem[];
  score: number;
  maxScore: number;
  tier: string;
  canPresent: boolean;
}

// ============================================================================
// Checklist Definition
// ============================================================================

const CHECKLIST_ITEMS: Omit<ChecklistItem, "checked">[] = [
  { number: 1, name: "Decision clarity", description: "Single clear choice with context", required: true, weight: 2 },
  { number: 2, name: "Status declared", description: "Status (open/answered/deferred/blocked) explicit", required: true, weight: 2 },
  { number: 3, name: "Upstream artifact linked", description: "Source plan or study path referenced", required: true, weight: 2 },
  { number: 4, name: "Options concrete", description: "Each option has code/diff, pros, cons, impact", required: true, weight: 2 },
  { number: 5, name: "Exploratory paths included", description: "STUDY/RESEARCH/DEEPENING options precede commitment", required: true, weight: 2 },
  { number: 6, name: "Mermaid diagram present", description: "At least one valid diagram", required: true, weight: 2 },
  { number: 7, name: "Diagram validated", description: "npm run check:mermaid passes", required: true, weight: 1 },
  { number: 8, name: "Token format correct", description: "CHOOSE_DECISION_<ID>_<OPTION> format", required: true, weight: 2 },
  { number: 9, name: "Blocking status declared", description: "Whether decision blocks implementation", required: true, weight: 1 },
  { number: 10, name: "Impact surface documented", description: "Affected files, systems, tests listed", required: true, weight: 1 },
  { number: 11, name: "Recommended option stated", description: "Recommendation with evidence", required: true, weight: 1 },
  { number: 12, name: "Inline summary compact", description: "Table has concrete identifiers", required: false, weight: 1 },
  { number: 13, name: "Answer persistence path clear", description: "How to persist the answer documented", required: false, weight: 1 },
  { number: 14, name: "Next decision queued", description: "Next unresolved decision identified", required: false, weight: 1 },
];

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse decision title, id, status, and heuristic tier from raw markdown content.
 *
 * @remarks
 * PURITY: inspects `content` only; does not read the filesystem. `path` defaults until patched by the caller.
 * @param content - Full decision markdown body.
 */
function extractMetadata(content: string): DecisionMetadata {
  const titleMatch = content.match(/^#\s*Decision:\s*(.+)/m);
  const idMatch = content.match(/\*\*Decision ID:\*\*\s*(.+)/mi);
  const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/mi);
  
  return {
    title: titleMatch?.[1]?.trim() || "Untitled Decision",
    path: "unknown",
    id: idMatch?.[1]?.trim() || "UNKNOWN",
    status: statusMatch?.[1]?.trim() || "open",
    tier: guessTier(content),
  };
}

/**
 * Classify packet richness as Full, Standard, or Minimal using length and pattern heuristics.
 *
 * @remarks
 * PURITY: derived from `content` alone; separate from checklist-weighted tier in {@link checkDecision}.
 * @param content - Full decision markdown body.
 */
function guessTier(content: string): string {
  const wordCount = content.split(/\s+/).length;
  const hasDiagram = /```mermaid|graph\s+\w+/im.test(content);
  const hasBlocking = /blocks?\s+implementation|blocking/i.test(content);
  
  if (wordCount > 800 && hasDiagram && hasBlocking) return "Full";
  if (wordCount > 400) return "Standard";
  return "Minimal";
}

/**
 * Evaluate whether a single checklist criterion matches the decision markdown.
 *
 * @remarks
 * PURITY: regex probes keyed by `item.number` must stay aligned with `CHECKLIST_ITEMS` ordering.
 * @param content - Full decision markdown body.
 * @param item - Checklist row definition without the runtime `checked` flag.
 */
function checkItem(content: string, item: Omit<ChecklistItem, "checked">): boolean {
  switch (item.number) {
    case 1: return /^#.*Decision:.*\n/m.test(content) && content.match(/^#.*Decision:.*\n/m)?.[0].length > 15;
    case 2: return /Status:|status.*(?:open|answered|deferred|blocked)/i.test(content);
    case 3: return /\.plans\/|\.studies\/|plan-|study-/i.test(content);
    case 4: return /Pros:|Cons:|pros:|cons:|impact/i.test(content);
    case 5: return /STUDY_OPTIONS|RESEARCH_OPTIONS|DEEPENING_OPTIONS/i.test(content);
    case 6: return /```mermaid|graph\s+\w+/im.test(content);
    case 7: return /check:mermaid|mermaid.*validated/i.test(content);
    case 8: return /CHOOSE_DECISION_\w+_\w+|`CHOOSE_DECISION_\w+_\w+`/i.test(content);
    case 9: return /blocks?\s+implementation|blocking.*decision/i.test(content);
    case 10: return /Affected\s+Files|Impact|impacted.*files/i.test(content);
    case 11: return /Recommendation|Recommended|recommend/i.test(content);
    case 12: return /\|.*\|.*\|/m.test(content);
    case 13: return /persist|persistence|write.*back/i.test(content);
    case 14: return /next.*decision|queue|following.*decision/i.test(content);
    default: return false;
  }
}

// ============================================================================
// Main
// ============================================================================

/**
 * Resolve the newest `decision-*.md` packet under `.tmp/decisions/<run-directory>/`.
 *
 * @remarks
 * I/O: lists and stats `.tmp/decisions` subdirectories; returns null when none exist or on read errors.
 * @returns Packet path when found; otherwise null.
 */
function findLatestDecision(): string | null {
  try {
    const tmpDir = ".tmp/decisions";
    if (!existsSync(tmpDir)) return null;
    
    const dirs = readdirSync(tmpDir)
      .filter(d => statSync(join(tmpDir, d)).isDirectory())
      .sort()
      .reverse();
    
    for (const dir of dirs) {
      const packetFile = join(tmpDir, dir, readdirSync(join(tmpDir, dir))
        .find(f => f.startsWith("decision-") && f.endsWith(".md")));
      if (packetFile) return packetFile;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Score a decision packet and print JSON or a human-readable completeness report.
 *
 * @remarks
 * I/O: reads `packetPath` from disk; writes to stdout/stderr; calls `process.exit(1)` on read failures.
 * @param packetPath - Filesystem path to the decision markdown packet.
 * @param json - When true, emit JSON only; when false, emit the formatted console report.
 */
function checkDecision(packetPath: string, json: boolean = false): void {
  try {
    const content = readFileSync(packetPath, "utf-8");
    const metadata = extractMetadata(content);
    metadata.path = packetPath;
    
    const checklist = CHECKLIST_ITEMS.map(item => ({
      ...item,
      checked: checkItem(content, item),
    }));
    
    const score = checklist.reduce((sum, item) => 
      item.checked ? sum + item.weight : sum, 0);
    const maxScore = checklist.reduce((sum, item) => sum + item.weight, 0);
    
    const requiredItems = checklist.filter(i => i.required);
    const requiredScore = requiredItems.reduce((sum, item) => 
      item.checked ? sum + item.weight : sum, 0);
    const requiredMax = requiredItems.reduce((sum, item) => sum + item.weight, 0);
    
    const canPresent = requiredScore === requiredMax;
    
    const tier = score >= 24 ? "Full" : score >= 18 ? "Standard" : "Minimal";

    const report: CompletenessReport = {
      metadata,
      checklist,
      score,
      maxScore,
      tier,
      canPresent,
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Human-readable output
    console.log("\n📋 Decision Completeness Report");
    console.log("═".repeat(60));
    console.log(`\n📄 ${metadata.title}`);
    console.log(`   ID: ${metadata.id}`);
    console.log(`   Status: ${metadata.status}`);
    console.log(`   Path: ${packetPath}`);
    
    console.log(`\n📊 Score: ${score}/${maxScore} (${((score/maxScore)*100).toFixed(0)}%)`);
    console.log(`   Required items: ${requiredScore}/${requiredMax}`);
    console.log(`   Quality tier: ${tier}`);
    
    console.log(`\n${canPresent ? "✅" : "⚠️"} Presentable: ${canPresent ? "YES" : "NEEDS WORK"}`);
    
    console.log("\n📝 Checklist:");
    for (const item of checklist) {
      const icon = item.checked ? "✅" : item.required ? "❌" : "⚠️";
      console.log(`   ${icon} [${item.number}] ${item.name}`);
    }
    
    console.log("\n" + "═".repeat(60));
    
    if (!canPresent) {
      console.log("\n⚠️ Decision needs work before presenting.");
      const failedItems = checklist.filter(i => !i.checked && i.required);
      if (failedItems.length > 0) {
        console.log("\nMissing required items:");
        failedItems.forEach(i => console.log(`   - ${item.name}`));
      }
    } else {
      console.log("\n✅ Decision is complete and ready to present.");
    }
    
  } catch (error) {
    console.error(`\n❌ Error reading decision packet: ${packetPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// CLI
const args = argv.slice(2);
const packetArg = args.find(a => a === "--packet" || a === "-p");
const latestArg = args.includes("--latest");
const jsonArg = args.includes("--json");

if (!packetArg && !latestArg) {
  console.log("Usage: check-decision-completeness.ts --packet <path> | --latest [--json]");
  console.log("\nExamples:");
  console.log("  npx tsx check-decision-completeness.ts --packet .tmp/decisions/2026-05-19-test/decision-test.md");
  console.log("  npx tsx check-decision-completeness.ts --latest");
  console.log("  npx tsx check-decision-completeness.ts --latest --json");
  process.exit(1);
}

let packetPath: string | null = null;

if (latestArg) {
  packetPath = findLatestDecision();
  if (!packetPath) {
    console.error("❌ No decision packet found in .tmp/decisions/ directory.");
    process.exit(1);
  }
  console.log(`📍 Using latest decision: ${packetPath}`);
} else if (packetArg) {
  const packetIndex = args.indexOf(packetArg);
  packetPath = args[packetIndex + 1];
  if (!packetPath) {
    console.error("❌ Missing packet path after --packet");
    process.exit(1);
  }
}

checkDecision(packetPath!, jsonArg);
