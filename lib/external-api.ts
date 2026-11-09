import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import type { InstagramMedia } from "@/lib/meta/client";

// API externa (bot do Telegram / N8N): token unico no cabecalho Authorization.
export const EXTERNAL_TOKEN_MIN_LENGTH = 32;

function configuredToken(): string | null {
  const token = process.env.EXTERNAL_API_TOKEN?.trim();
  return token && token.length >= EXTERNAL_TOKEN_MIN_LENGTH ? token : null;
}

// Comparar o SHA-256 dos dois lados mantem o tempo constante mesmo com tamanhos diferentes.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export type ExternalAuth = "ok" | "disabled" | "unauthorized";

export function checkExternalAuth(authorization: string | null): ExternalAuth {
  const token = configuredToken();
  if (!token) return "disabled";
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return "unauthorized";
  return timingSafeEqual(digest(match[1].trim()), digest(token)) ? "ok" : "unauthorized";
}

export type ExternalWorkspace =
  | { ok: true; workspaceId: string }
  | { ok: false; status: 404 | 409; error: string };

export async function resolveExternalWorkspace(): Promise<ExternalWorkspace> {
  const configured = process.env.EXTERNAL_API_WORKSPACE_ID?.trim();
  if (configured) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: configured },
      select: { id: true },
    });
    return workspace
      ? { ok: true, workspaceId: workspace.id }
      : { ok: false, status: 404, error: "EXTERNAL_API_WORKSPACE_ID não existe" };
  }
  const all = await prisma.workspace.findMany({ select: { id: true }, take: 2 });
  if (all.length === 1) return { ok: true, workspaceId: all[0].id };
  if (all.length === 0) return { ok: false, status: 404, error: "Nenhum workspace encontrado" };
  return { ok: false, status: 409, error: "Há mais de um workspace: defina EXTERNAL_API_WORKSPACE_ID" };
}

export type ExternalGuard =
  | { ok: true; workspaceId: string }
  | { ok: false; response: NextResponse };

/** Ordem fixa: API ligada (503) -> token (401) -> workspace (404/409). */
export async function guardExternalRequest(request: NextRequest): Promise<ExternalGuard> {
  const auth = checkExternalAuth(request.headers.get("authorization"));
  if (auth === "disabled") {
    return { ok: false, response: NextResponse.json({ success: false, error: "API externa desligada" }, { status: 503 }) };
  }
  if (auth === "unauthorized") {
    return { ok: false, response: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  }
  const workspace = await resolveExternalWorkspace();
  if (!workspace.ok) {
    return { ok: false, response: NextResponse.json({ success: false, error: workspace.error }, { status: workspace.status }) };
  }
  return { ok: true, workspaceId: workspace.workspaceId };
}

export function toExternalPost(media: InstagramMedia) {
  return {
    id: media.id,
    // Por pontos de codigo (nao unidades UTF-16): cortar no meio de um emoji deixaria um surrogate solto.
    caption: Array.from((media.caption ?? "").replace(/\s+/g, " ").trim()).slice(0, 80).join(""),
    mediaType: media.media_type,
    productType: media.media_product_type ?? null,
    permalink: media.permalink ?? null,
    timestamp: media.timestamp,
  };
}

export function toExternalCampaign(automation: {
  id: string;
  name: string;
  postId: string | null;
  keywords: string[];
  isActive: boolean;
}) {
  return {
    id: automation.id,
    name: automation.name,
    postId: automation.postId,
    keywords: automation.keywords,
    isActive: automation.isActive,
    dashboardUrl: `${getBaseUrl()}/campaigns/${automation.id}`,
  };
}
