import { NextRequest, NextResponse } from "next/server";
import {
  createAutomationSchema,
  createCampaign,
  findExistingCampaign,
} from "@/lib/campaigns/create";
import { guardExternalRequest, toExternalCampaign } from "@/lib/external-api";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = await guardExternalRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 });
  }

  const parsed = createAutomationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    guard.workspaceId,
    parsed.data.instagramAccountId
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Conecte o Instagram antes de criar campanhas" },
      { status: 400 }
    );
  }

  const data = { ...parsed.data, instagramAccountId: account.id };

  // Idempotencia so faz sentido para campanha de um post especifico.
  if (data.postId && !data.matchAnyPost && !data.pendingNextReel && !data.matchAnyWord) {
    const existing = await findExistingCampaign({
      workspaceId: guard.workspaceId,
      instagramAccountId: account.id,
      postId: data.postId,
      keywords: data.keywords,
    });
    if (existing) {
      return NextResponse.json(
        { success: true, created: false, data: toExternalCampaign(existing) },
        { status: 200 }
      );
    }
  }

  const result = await createCampaign({ workspaceId: guard.workspaceId, data });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    { success: true, created: true, data: toExternalCampaign(result.automation) },
    { status: 201 }
  );
}
