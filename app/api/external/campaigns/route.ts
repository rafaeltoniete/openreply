import { NextRequest, NextResponse } from "next/server";
import {
  createAutomationSchema,
  createCampaign,
  findExistingCampaign,
} from "@/lib/campaigns/create";
import { guardExternalRequest, toExternalCampaign } from "@/lib/external-api";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";

export const dynamic = "force-dynamic";

// Trava por post: "achar a existente + criar" nao e atomico, e um toque duplo no bot vira duas
// execucoes paralelas do N8N. Sem isto as duas criariam, e o dm-worker casa TODA automacao ativa do
// post (cada comentarista receberia duas DMs e duas respostas publicas).
// So e correto porque o servico `web` roda com `replicas: 1` no docker-stack.yml (ja exigido pelas
// migracoes); com mais replicas seria preciso uma guarda no banco.
const postLocks = new Map<string, Promise<unknown>>();

async function withPostLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = postLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  postLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (postLocks.get(key) === current) postLocks.delete(key);
  }
}

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

  // Idempotencia so faz sentido para campanha de um post especifico. Campanhas "qualquer palavra"
  // guardam keywords: [] (nao ha o que comparar), por isso de proposito nao sao deduplicadas.
  const dedupe = Boolean(data.postId && !data.matchAnyPost && !data.pendingNextReel && !data.matchAnyWord);

  const run = async () => {
    if (dedupe) {
      const existing = await findExistingCampaign({
        workspaceId: guard.workspaceId,
        instagramAccountId: account.id,
        postId: data.postId as string,
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
  };

  if (!dedupe) return run();
  return withPostLock(`${guard.workspaceId}:${account.id}:${data.postId}`, run);
}
