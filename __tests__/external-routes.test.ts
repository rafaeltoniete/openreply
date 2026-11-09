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

    mockInstagram.getUserMedia.mockRejectedValueOnce(new Error("token=SEGREDO expirou"));
    const falha = await getPosts(getReq());
    expect(falha.status).toBe(502);
    const corpo = JSON.stringify(await falha.json());
    expect(corpo).toContain("Falha ao buscar posts no Instagram");
    expect(corpo).not.toContain("SEGREDO");
  });
});
