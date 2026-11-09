import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  checkExternalAuth,
  guardExternalRequest,
  resolveExternalWorkspace,
  toExternalCampaign,
  toExternalPost,
} from "../lib/external-api";

const TOKEN = "t".repeat(40);
const req = (authorization?: string) =>
  new NextRequest("http://localhost/api/external/posts", {
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("checkExternalAuth", () => {
  it("desligada quando o token nao existe ou e curto", () => {
    expect(checkExternalAuth(`Bearer ${TOKEN}`)).toBe("disabled");
    vi.stubEnv("EXTERNAL_API_TOKEN", "curto");
    expect(checkExternalAuth("Bearer curto")).toBe("disabled");
    vi.stubEnv("EXTERNAL_API_TOKEN", "x".repeat(31));
    expect(checkExternalAuth(`Bearer ${"x".repeat(31)}`)).toBe("disabled");
  });

  it("recusa cabecalho ausente, de outro tipo ou com token errado (inclusive de outro tamanho)", () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    for (const h of [null, "", "Basic abc", `Bearer ${"u".repeat(40)}`, "Bearer x", `Bearer ${TOKEN}x`, TOKEN]) {
      expect(checkExternalAuth(h), String(h)).toBe("unauthorized");
    }
  });

  it("aceita o token certo, com 'bearer' em qualquer caixa e espacos nas pontas", () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    expect(checkExternalAuth(`Bearer ${TOKEN}`)).toBe("ok");
    expect(checkExternalAuth(`bearer ${TOKEN}`)).toBe("ok");
    expect(checkExternalAuth(`Bearer   ${TOKEN}  `)).toBe("ok");
  });
});

describe("resolveExternalWorkspace", () => {
  it("usa EXTERNAL_API_WORKSPACE_ID quando existe, e 404 quando nao existe", async () => {
    vi.stubEnv("EXTERNAL_API_WORKSPACE_ID", "ws_9");
    mockPrisma.workspace.findUnique.mockResolvedValueOnce({ id: "ws_9" });
    expect(await resolveExternalWorkspace()).toEqual({ ok: true, workspaceId: "ws_9" });
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({ where: { id: "ws_9" }, select: { id: true } });
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(null);
    expect(await resolveExternalWorkspace()).toEqual({ ok: false, status: 404, error: "EXTERNAL_API_WORKSPACE_ID não existe" });
  });

  it("sem a variavel: usa o unico workspace; zero vira 404; mais de um vira 409", async () => {
    mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: "ws_1" }]);
    expect(await resolveExternalWorkspace()).toEqual({ ok: true, workspaceId: "ws_1" });
    expect(mockPrisma.workspace.findMany).toHaveBeenCalledWith({ select: { id: true }, take: 2 });
    mockPrisma.workspace.findMany.mockResolvedValueOnce([]);
    expect(await resolveExternalWorkspace()).toEqual({ ok: false, status: 404, error: "Nenhum workspace encontrado" });
    mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    expect(await resolveExternalWorkspace()).toEqual({ ok: false, status: 409, error: "Há mais de um workspace: defina EXTERNAL_API_WORKSPACE_ID" });
  });
});

describe("guardExternalRequest", () => {
  it("503 desligada e 401 token errado, sem encostar no banco", async () => {
    const desligada = await guardExternalRequest(req(`Bearer ${TOKEN}`));
    expect(desligada.ok).toBe(false);
    if (!desligada.ok) {
      expect(desligada.response.status).toBe(503);
      expect(await desligada.response.json()).toEqual({ success: false, error: "API externa desligada" });
    }
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    const errada = await guardExternalRequest(req("Bearer errado"));
    expect(errada.ok).toBe(false);
    if (!errada.ok) {
      expect(errada.response.status).toBe(401);
      expect(await errada.response.json()).toEqual({ success: false, error: "Unauthorized" });
    }
    expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("com token certo devolve o workspace; ambiguo vira a resposta 409", async () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: "ws_1" }]);
    expect(await guardExternalRequest(req(`Bearer ${TOKEN}`))).toEqual({ ok: true, workspaceId: "ws_1" });
    mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    const ambiguo = await guardExternalRequest(req(`Bearer ${TOKEN}`));
    expect(ambiguo.ok).toBe(false);
    if (!ambiguo.ok) expect(ambiguo.response.status).toBe(409);
  });

  it("nunca devolve o token na resposta", async () => {
    vi.stubEnv("EXTERNAL_API_TOKEN", TOKEN);
    const r = await guardExternalRequest(req("Bearer errado"));
    if (!r.ok) expect(JSON.stringify(await r.response.json())).not.toContain(TOKEN);
  });
});

describe("mapeamentos", () => {
  it("toExternalPost corta a legenda em 80, colapsa espacos e nao inventa campos", () => {
    const longa = `Linha um\n\n   linha   dois ${"x".repeat(200)}`;
    const p = toExternalPost({ id: "1", caption: longa, media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", permalink: "https://www.instagram.com/p/A/", timestamp: "2026-11-09T10:00:00+0000", like_count: 5 });
    expect(p).toEqual({ id: "1", caption: p.caption, mediaType: "CAROUSEL_ALBUM", productType: "FEED", permalink: "https://www.instagram.com/p/A/", timestamp: "2026-11-09T10:00:00+0000" });
    expect(p.caption.length).toBeLessThanOrEqual(80);
    expect(p.caption.startsWith("Linha um linha dois ")).toBe(true);
    expect(toExternalPost({ id: "2", media_type: "IMAGE", timestamp: "t" })).toEqual({ id: "2", caption: "", mediaType: "IMAGE", productType: null, permalink: null, timestamp: "t" });
  });

  it("toExternalCampaign monta o link do painel com NEXTAUTH_URL", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://openreply.zapin.pro");
    expect(toExternalCampaign({ id: "auto_1", name: "N", postId: "p", keywords: ["A"], extra: 1 } as never)).toEqual({
      id: "auto_1", name: "N", postId: "p", keywords: ["A"], dashboardUrl: "https://openreply.zapin.pro/campaigns/auto_1",
    });
  });
});
