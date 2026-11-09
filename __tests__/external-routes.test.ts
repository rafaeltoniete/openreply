import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockInstagram, mockAccounts } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn(), findMany: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: { create: vi.fn(), findMany: vi.fn() },
  },
  mockInstagram: { createInstagramContext: vi.fn(), getUserMedia: vi.fn() },
  mockAccounts: { getWorkspaceInstagramAccount: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => mockInstagram);
vi.mock("@/lib/instagram-accounts", () => mockAccounts);

import { GET as getPosts } from "../app/api/external/posts/route";
import { POST as postCampaign } from "../app/api/external/campaigns/route";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
  mockPrisma.workspace.findMany.mockResolvedValue([{ id: "ws_1" }]);
});
afterEach(() => vi.unstubAllEnvs());

const getReq = (query = "", headers: Record<string, string> = auth) =>
  new NextRequest(`http://localhost/api/external/posts${query}`, { headers });

describe("GET /api/external/posts", () => {
  const media = Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`,
    caption: `Legenda ${i}`,
    media_type: "CAROUSEL_ALBUM",
    permalink: `https://www.instagram.com/p/${i}/`,
    timestamp: "2026-11-09T10:00:00+0000",
  }));

  beforeEach(() => {
    mockAccounts.getWorkspaceInstagramAccount.mockResolvedValue({ id: "acc_1" });
    mockInstagram.createInstagramContext.mockResolvedValue({ provider: "META" });
    mockInstagram.getUserMedia.mockResolvedValue(media);
  });

  it("lista os posts mapeados, com limit 5 por padrao", async () => {
    const res = await getPosts(getReq());
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.success).toBe(true);
    expect(corpo.data).toHaveLength(3);
    expect(corpo.data[0]).toEqual({ id: "m0", caption: "Legenda 0", mediaType: "CAROUSEL_ALBUM", productType: null, permalink: "https://www.instagram.com/p/0/", timestamp: "2026-11-09T10:00:00+0000" });
    expect(mockInstagram.getUserMedia).toHaveBeenCalledWith({ context: { provider: "META" }, limit: 5 });
    expect(mockAccounts.getWorkspaceInstagramAccount).toHaveBeenCalledWith("ws_1", null);
  });

  it("limita o limit entre 1 e 25 e repassa a conta pedida", async () => {
    await getPosts(getReq("?limit=999&instagramAccountId=acc_9"));
    expect(mockInstagram.getUserMedia).toHaveBeenLastCalledWith({ context: { provider: "META" }, limit: 25 });
    expect(mockAccounts.getWorkspaceInstagramAccount).toHaveBeenLastCalledWith("ws_1", "acc_9");
    await getPosts(getReq("?limit=0"));
    expect(mockInstagram.getUserMedia).toHaveBeenLastCalledWith({ context: { provider: "META" }, limit: 1 });
    await getPosts(getReq("?limit=abc"));
    expect(mockInstagram.getUserMedia).toHaveBeenLastCalledWith({ context: { provider: "META" }, limit: 5 });
  });

  it("503 desligada, 401 sem token e nada de Instagram nessas respostas", async () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", "");
    expect((await getPosts(getReq())).status).toBe(503);
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    expect((await getPosts(getReq("", {}))).status).toBe(401);
    expect(mockInstagram.getUserMedia).not.toHaveBeenCalled();
  });

  it("400 sem conta conectada e 502 quando o Instagram falha (sem vazar o erro)", async () => {
    mockAccounts.getWorkspaceInstagramAccount.mockResolvedValueOnce(null);
    const semConta = await getPosts(getReq());
    expect(semConta.status).toBe(400);
    expect((await semConta.json()).error).toBe("Conecte o Instagram antes de listar posts");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInstagram.getUserMedia.mockRejectedValueOnce(new Error("token=SEGREDO expirou"));
    const falha = await getPosts(getReq());
    expect(falha.status).toBe(502);
    const corpo = JSON.stringify(await falha.json());
    expect(corpo).toContain("Falha ao buscar posts no Instagram");
    expect(corpo).not.toContain("SEGREDO");
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SEGREDO");
    spy.mockRestore();
  });
});

describe("POST /api/external/campaigns", () => {
  const BODY = {
    name: "toniete.ai · meu-post",
    postId: "17900000000000001",
    postUrl: "https://www.instagram.com/p/ABC123/",
    keywords: ["CLAUDE"],
    dmMessage: "Pronto, {username}!",
    requireFollow: true,
    followPromptMessage: "Me segue antes",
    followPromptButtonLabel: "Já estou seguindo ✅",
    linkButtonLabel: "Abrir o material",
    trackedDestinationUrl: "https://toniete-ai.vercel.app/l/claude/",
  };
  const postReq = (body: unknown, headers: Record<string, string> = { ...auth, "content-type": "application/json" }) =>
    new NextRequest("http://localhost/api/external/campaigns", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    });

  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://openreply.zapin.pro");
    mockAccounts.getWorkspaceInstagramAccount.mockResolvedValue({ id: "acc_1" });
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1" });
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc_1" });
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.create.mockImplementation(async ({ data }) => ({ id: "auto_1", ...data }));
  });

  it("cria e responde 201 com created:true e o link do painel", async () => {
    const res = await postCampaign(postReq(BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      created: true,
      data: { id: "auto_1", name: BODY.name, postId: BODY.postId, keywords: ["CLAUDE"], dashboardUrl: "https://openreply.zapin.pro/campaigns/auto_1" },
    });
    expect(mockPrisma.automation.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws_1", instagramAccountId: "acc_1", requireFollow: true, keywords: ["CLAUDE"],
    });
  });

  it("e idempotente: mesma conta, post e palavras (outra caixa) devolve a existente com 200 e nao cria", async () => {
    mockPrisma.automation.findMany.mockResolvedValueOnce([{ id: "auto_0", name: "Antiga", postId: BODY.postId, keywords: ["claude"] }]);
    const res = await postCampaign(postReq(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      created: false,
      data: { id: "auto_0", name: "Antiga", postId: BODY.postId, keywords: ["claude"], dashboardUrl: "https://openreply.zapin.pro/campaigns/auto_0" },
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", instagramAccountId: "acc_1", postId: BODY.postId },
      select: { id: true, name: true, postId: true, keywords: true },
    });
  });

  it("palavras diferentes no mesmo post criam outra campanha", async () => {
    mockPrisma.automation.findMany.mockResolvedValueOnce([{ id: "auto_0", name: "Outra", postId: BODY.postId, keywords: ["N8N"] }]);
    const res = await postCampaign(postReq(BODY));
    expect(res.status).toBe(201);
  });

  it("campanha de 'proximo reel' nao passa pela checagem de duplicada", async () => {
    const { postId: _p, postUrl: _u, ...semPost } = BODY;
    void _p; void _u;
    const res = await postCampaign(postReq({ ...semPost, pendingNextReel: true }));
    expect(res.status).toBe(201);
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("503 desligada, 401 sem token, 409 workspace ambiguo; nada e criado", async () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", "");
    expect((await postCampaign(postReq(BODY))).status).toBe(503);
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    expect((await postCampaign(postReq(BODY, { "content-type": "application/json" }))).status).toBe(401);
    mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    expect((await postCampaign(postReq(BODY))).status).toBe(409);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("400 para JSON quebrado, schema invalido (botao longo, sem palavra) e Instagram nao conectado", async () => {
    const quebrado = await postCampaign(postReq("{nao e json"));
    expect(quebrado.status).toBe(400);
    expect((await quebrado.json()).error).toBe("JSON inválido");

    const botaoLongo = await postCampaign(postReq({ ...BODY, followPromptButtonLabel: "x".repeat(21) }));
    expect(botaoLongo.status).toBe(400);
    expect((await botaoLongo.json()).error).toBe("Invalid input");

    expect((await postCampaign(postReq({ ...BODY, keywords: [] }))).status).toBe(400);

    mockAccounts.getWorkspaceInstagramAccount.mockResolvedValueOnce(null);
    const semConta = await postCampaign(postReq(BODY));
    expect(semConta.status).toBe(400);
    expect((await semConta.json()).error).toBe("Conecte o Instagram antes de criar campanhas");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });
});
