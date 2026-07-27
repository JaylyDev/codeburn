import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";

import { decodeDevin } from "@codeburn/core/providers/devin";
import type { DevinDecodedCall, DevinSessionMetadata } from "@codeburn/core/providers/devin";

import { getShortModelName } from "../models.js";
import { openDatabase } from "../sqlite.js";
import { readConfig } from "../config.js";
import { readSessionFile } from "../fs-utils.js";
import { createBridgedProvider } from "./bridge.js";
import type { Provider, SessionSource, ParsedProviderCall } from "./types.js";

const DEFAULT_DEVIN_CLI_DIR = join(
  homedir(),
  ".local",
  "share",
  "devin",
  "cli",
);

const DEVIN_PROVIDER_NAME = "devin";
const DEVIN_PROVIDER_DISPLAY_NAME = "Devin";
const DEVIN_TRANSCRIPTS_SUBDIR = "transcripts";
const DEVIN_SESSIONS_DB = "sessions.db";
const DEVIN_EFFORT_TIERS = new Set(["xhigh", "high", "medium", "low"]);

function getFriendlyGptName(model: string): string {
  const shortName = getShortModelName(model);
  const match = model.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/);
  if (!match) return shortName;

  const suffixParts = match[2]?.split("-").filter(Boolean) ?? [];
  // A purely numeric suffix token means this is a dated snapshot id such as
  // gpt-4-1106-preview, not a clean version+word id. Fabricating a friendly
  // name here would mislabel the date as text (e.g. "GPT-4 1106 Preview"), so
  // defer to getShortModelName, which passes unknown snapshots through raw.
  if (suffixParts.some((part) => /^\d+$/.test(part))) return shortName;

  const suffix = suffixParts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  const reconstructed = `GPT-${match[1]}${suffix ? ` ${suffix}` : ""}`;
  if (shortName !== model && (!suffix || shortName !== `GPT-${match[1]}`)) {
    return shortName;
  }

  return reconstructed;
}

function getDevinDisplayModelName(
  generationModel: string | undefined,
  modelName: string,
): string {
  if (!generationModel || /^MODEL_/.test(generationModel)) {
    return getShortModelName(modelName);
  }

  if (generationModel.startsWith("gpt-")) {
    // Devin minor versions are always a single digit (gpt-5-3-codex). Restrict
    // the dash-to-dot rewrite to a single-digit minor at a token boundary so a
    // dated snapshot like gpt-4-1106-preview is not misread as version 4.1106.
    const normalized = generationModel.replace(/^gpt-(\d+)-(\d)(?=-|$)/, "gpt-$1.$2");
    const effortMatch = normalized.match(/-([^-]+)$/);
    const effort = effortMatch && DEVIN_EFFORT_TIERS.has(effortMatch[1]!)
      ? effortMatch[1]
      : undefined;
    const base = effort ? normalized.slice(0, -(effort.length + 1)) : normalized;
    const friendlyBase = getFriendlyGptName(base);
    return effort ? `${friendlyBase} (${effort})` : friendlyBase;
  }

  return getShortModelName(generationModel);
}

function parseNumericTimestamp(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function projectNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[/\\]+$/, "");
  return normalized.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function getProjectName(
  source: SessionSource,
  session: DevinSessionMetadata | null,
): string {
  if (session?.workingDirectory)
    return projectNameFromPath(session.workingDirectory);
  if (session?.title) return session.title;
  return source.project;
}

function loadSessionMetadata(
  dbPath: string,
): Map<string, DevinSessionMetadata> {
  const sessions = new Map<string, DevinSessionMetadata>();
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    const rows = db.query<{
      id: string;
      working_directory: string;
      model: string;
      title: string | null;
      created_at: number;
      last_activity_at: number;
      hidden: number;
    }>(
      `SELECT id, working_directory, model, title, created_at, last_activity_at, hidden
       FROM sessions`,
    );
    for (const row of rows) {
      if (!row.id) continue;
      sessions.set(row.id, {
        id: row.id,
        workingDirectory: row.working_directory,
        model: row.model,
        title: row.title ?? undefined,
        createdAt: parseNumericTimestamp(row.created_at),
        lastActivityAt: parseNumericTimestamp(row.last_activity_at),
        hidden: !!row.hidden,
      });
    }
  } catch {
    return sessions;
  } finally {
    db?.close();
  }
  return sessions;
}

async function getCostFactor(): Promise<number | null> {
  const configRate = (await readConfig()).devin?.acuUsdRate;
  return typeof configRate === 'number' && Number.isFinite(configRate) && configRate > 0 ? configRate : null;
}

function toProviderCall(rich: DevinDecodedCall, costFactor: number): ParsedProviderCall {
  return {
    provider: DEVIN_PROVIDER_NAME,
    model: getDevinDisplayModelName(rich.generationModel, rich.modelName),
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    // Devin prices itself (committed ACU x the configured USD rate), so the
    // call carries no `costBasis` marker and the pricing pass leaves it alone.
    costUSD: rich.committedAcuCost * costFactor,
    tools: rich.tools,
    bashCommands: rich.rawBashCommands,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  };
}

export function createDevinProvider(cliDir: string): Provider {
  const sessionsDbPath = join(cliDir, DEVIN_SESSIONS_DB);
  let sessionMetadata: Map<string, DevinSessionMetadata> | null = null;
  let costFactor: number | null | undefined;

  const getSessionMetadata = () => {
    if (!sessionMetadata) sessionMetadata = loadSessionMetadata(sessionsDbPath);
    return sessionMetadata;
  };

  const getCachedCostFactor = async (): Promise<number | null> => {
    if (costFactor === undefined) costFactor = await getCostFactor();
    return costFactor;
  };

  return createBridgedProvider<DevinDecodedCall>({
    name: DEVIN_PROVIDER_NAME,
    displayName: DEVIN_PROVIDER_DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return model;
    },

    toolDisplayName(rawTool: string): string {
      return rawTool;
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if ((await getCachedCostFactor()) === null) return [];

      const transcriptsDir = join(cliDir, DEVIN_TRANSCRIPTS_SUBDIR);
      const entries = await readdir(transcriptsDir).catch(() => []);
      const metadata = getSessionMetadata();
      const sources: SessionSource[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const filePath = join(transcriptsDir, entry);
        const pathStats = await stat(filePath).catch(() => null);

        if (!pathStats?.isFile()) continue;

        const session = metadata.get(basename(filePath, ".json")) ?? null;
        if (session?.hidden) continue;

        const tmpSource: SessionSource = {
          path: filePath,
          project: DEVIN_PROVIDER_NAME,
          provider: DEVIN_PROVIDER_NAME,
        };

        const project = getProjectName(tmpSource, session);

        sources.push({
          path: filePath,
          project,
          provider: DEVIN_PROVIDER_NAME,
        });
      }

      return sources;
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const factor = await getCachedCostFactor();
      if (factor === null) return null;

      const raw = await readSessionFile(source.path);
      if (!raw) return null;

      let transcript: { session_id?: string; agent?: unknown; steps?: unknown[] } | null = null;
      try {
        transcript = JSON.parse(raw) as { session_id?: string; agent?: unknown; steps?: unknown[] };
      } catch {
        return null;
      }
      if (!transcript || Array.isArray(transcript) || !Array.isArray(transcript.steps)) return null;

      const sessionId = transcript.session_id?.trim() || basename(source.path, '.json');
      const session = getSessionMetadata().get(sessionId) ?? null;

      return [{ transcript, session, project: source.project, sessionId }];
    },

    decode: decodeDevin,

    toProviderCall(rich: DevinDecodedCall): ParsedProviderCall {
      // readRecords returns null unless the configured ACU rate resolved, so a
      // call only reaches this point once `costFactor` is a positive number.
      return toProviderCall(rich, costFactor!);
    },
  });
}

export const devin = createDevinProvider(DEFAULT_DEVIN_CLI_DIR);
