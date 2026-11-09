import { NextRequest, NextResponse } from "next/server";
import { guardExternalRequest, toExternalPost } from "@/lib/external-api";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

export async function GET(request: NextRequest) {
  const guard = await guardExternalRequest(request);
  if (!guard.ok) return guard.response;

  const parsedLimit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const account = await getWorkspaceInstagramAccount(
    guard.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Conecte o Instagram antes de listar posts" },
      { status: 400 }
    );
  }

  try {
    const context = await createInstagramContext(account);
    const media = await getUserMedia({ context, limit });
    return NextResponse.json({ success: true, data: media.map(toExternalPost) });
  } catch (err) {
    console.error("[External API] Falha ao buscar posts no Instagram", err instanceof Error ? err.name : "erro desconhecido");
    return NextResponse.json(
      { success: false, error: "Falha ao buscar posts no Instagram" },
      { status: 502 }
    );
  }
}
