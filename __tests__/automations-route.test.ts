/**
 * POST /api/automations (painel) — caracterização.
 * Trava o comportamento atual antes de extrair a criação para lib/campaigns/create.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: { create: vi.fn() },
  },
  mockContext: { current: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext.current,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { POST } from "../app/api/automations/route";

const BODY = {
  name: "toniete.ai · meu-post",
  goal: "Entregar o material do post meu-post",
  postId: "17900000000000001",
  postUrl: "https://www.instagram.com/p/ABC123/",
  keywords: ["CLAUDE"],
  dmMessage: "Pronto, {username}!",
  linkButtonLabel: "Abrir o material",
  requireFollow: true,
  followPromptMessage: "Me segue antes",
  followPromptButtonLabel: "Já estou seguindo ✅",
  publicReplyEnabled: true,
  publicReplyMessages: ["Te mandei no direct! 📩", "Confere o direct! 🚀"],
  trackedDestinationUrl: "https://toniete-ai.vercel.app/l/claude/",
};

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/automations", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

const created = { id: "auto_1", name: BODY.name, trackedLinks: [{ id: "link_1" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.current.mockResolvedValue({ workspaceId: "ws_1", role: "OWNER" });
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc_1" });
  mockPrisma.automation.create.mockResolvedValue(created);
});

describe("POST /api/automations (painel)", () => {
  it("cria a campanha com o mapeamento completo e responde 201", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: created });
    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: BODY.name,
        goal: BODY.goal,
        postId: BODY.postId,
        postUrl: BODY.postUrl,
        pendingNextReel: false,
        matchAnyPost: false,
        keywords: ["CLAUDE"],
        matchAnyWord: false,
        dmTriggerEnabled: false,
        dmMessage: BODY.dmMessage,
        openingDmEnabled: false,
        openingDmMessage: null,
        openingDmButtonLabel: null,
        linkButtonLabel: BODY.linkButtonLabel,
        requireFollow: true,
        followPromptMessage: BODY.followPromptMessage,
        followPromptButtonLabel: BODY.followPromptButtonLabel,
        followUpEnabled: false,
        followUpMessage: null,
        followUpDelayMinutes: 0,
        publicReplyEnabled: true,
        publicReplyMessages: BODY.publicReplyMessages,
        publicReplyMessage: BODY.publicReplyMessages[0],
        isActive: true,
        wholeWordMatch: true,
        workspaceId: "ws_1",
        instagramAccountId: "acc_1",
        reportShareSlug: expect.any(String),
        trackedLinks: {
          create: [
            {
              workspaceId: "ws_1",
              slug: expect.any(String),
              label: "Primary campaign link",
              destinationUrl: BODY.trackedDestinationUrl,
            },
          ],
        },
      }),
      include: { trackedLinks: true },
    });
  });

  it("usa a conta pedida, e a mais recente quando nao pede (ou pede 'all')", async () => {
    await post({ ...BODY, instagramAccountId: "acc_9" });
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith({
      where: { id: "acc_9", workspaceId: "ws_1" },
    });
    await post(BODY);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith({
      where: { workspaceId: "ws_1" },
      orderBy: { connectedAt: "desc" },
    });
    await post({ ...BODY, instagramAccountId: "all" });
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith({
      where: { workspaceId: "ws_1" },
      orderBy: { connectedAt: "desc" },
    });
  });

  it("recusa sem sessao (401), sem permissao (403) e com corpo invalido (400)", async () => {
    mockContext.current.mockResolvedValueOnce(null);
    const semSessao = await post(BODY);
    expect(semSessao.status).toBe(401);
    expect(await semSessao.json()).toEqual({ success: false, error: "Unauthorized" });

    mockContext.current.mockResolvedValueOnce({ workspaceId: "ws_1", role: "MEMBER" });
    const semPermissao = await post(BODY);
    expect(semPermissao.status).toBe(403);
    expect((await semPermissao.json()).error).toBe("Only owners and admins can create campaigns");

    const { dmMessage: _omit, ...semMensagem } = BODY;
    void _omit;
    const invalido = await post(semMensagem);
    expect(invalido.status).toBe(400);
    const corpo = await invalido.json();
    expect(corpo.error).toBe("Invalid input");
    expect(corpo.details.fieldErrors.dmMessage).toBeDefined();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("recusa campanha sem palavra e sem post (400) e botao com mais de 20 caracteres", async () => {
    const semPalavra = await post({ ...BODY, keywords: [] });
    expect(semPalavra.status).toBe(400);
    const semPost = await post({ ...BODY, postId: null });
    expect(semPost.status).toBe(400);
    const botaoLongo = await post({ ...BODY, followPromptButtonLabel: "x".repeat(21) });
    expect(botaoLongo.status).toBe(400);
  });

  it("responde 404 sem workspace e 400 sem conta do Instagram", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(null);
    const semWorkspace = await post(BODY);
    expect(semWorkspace.status).toBe(404);
    expect((await semWorkspace.json()).error).toBe("Workspace not found");

    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    const semConta = await post(BODY);
    expect(semConta.status).toBe(400);
    expect((await semConta.json()).error).toBe("Connect Instagram before creating campaigns");
  });
});
