import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: { create: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  createAutomationSchema,
  createCampaign,
  findExistingCampaign,
} from "../lib/campaigns/create";

const base = {
  name: "Campanha",
  postId: "17900000000000001",
  keywords: ["CLAUDE"],
  dmMessage: "Pronto!",
};
const parse = (extra: Record<string, unknown> = {}) =>
  createAutomationSchema.parse({ ...base, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc_1" });
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({ id: "auto_1", ...data }));
});

describe("createCampaign", () => {
  it("cria e devolve a linha com ok:true", async () => {
    const r = await createCampaign({ workspaceId: "ws_1", data: parse() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.automation).toMatchObject({ id: "auto_1", workspaceId: "ws_1", instagramAccountId: "acc_1", postId: base.postId });
  });

  it("devolve 404 sem workspace e 400 sem conta do Instagram, sem criar nada", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(null);
    expect(await createCampaign({ workspaceId: "ws_1", data: parse() })).toEqual({ ok: false, status: 404, error: "Workspace not found" });
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    expect(await createCampaign({ workspaceId: "ws_1", data: parse() })).toEqual({ ok: false, status: 400, error: "Connect Instagram before creating campaigns" });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("cria o link rastreado principal e o secundario com o rotulo pedido", async () => {
    await createCampaign({
      workspaceId: "ws_1",
      data: parse({ trackedDestinationUrl: "https://a.com/x", secondaryDestinationUrl: "https://b.com/y", secondaryButtonLabel: "Guia" }),
    });
    const { data } = mockPrisma.automation.create.mock.calls[0][0];
    expect(data.trackedLinks.create).toEqual([
      { workspaceId: "ws_1", slug: expect.any(String), label: "Primary campaign link", destinationUrl: "https://a.com/x" },
      { workspaceId: "ws_1", slug: expect.any(String), label: "Guia", destinationUrl: "https://b.com/y" },
    ]);
  });

  it("proximo reel e 'qualquer post' nao guardam o post; 'qualquer palavra' zera as palavras", async () => {
    await createCampaign({ workspaceId: "ws_1", data: parse({ pendingNextReel: true, postUrl: "https://www.instagram.com/p/X/" }) });
    expect(mockPrisma.automation.create.mock.calls[0][0].data).toMatchObject({ postId: null, postUrl: null, pendingNextReel: true });
    await createCampaign({ workspaceId: "ws_1", data: parse({ matchAnyWord: true }) });
    expect(mockPrisma.automation.create.mock.calls[1][0].data).toMatchObject({ keywords: [], matchAnyWord: true });
  });

  it("sem link rastreado nao manda trackedLinks", async () => {
    await createCampaign({ workspaceId: "ws_1", data: parse() });
    expect(mockPrisma.automation.create.mock.calls[0][0].data).not.toHaveProperty("trackedLinks");
  });
});

describe("findExistingCampaign", () => {
  const params = { workspaceId: "ws_1", instagramAccountId: "acc_1", postId: "p1", keywords: ["claude"] };

  it("acha a campanha do mesmo post com as mesmas palavras, sem diferenciar maiuscula nem ordem", async () => {
    mockPrisma.automation.findMany.mockResolvedValueOnce([
      { id: "a", name: "A", postId: "p1", keywords: ["N8N"] },
      { id: "b", name: "B", postId: "p1", keywords: ["CLAUDE"] },
    ]);
    expect(await findExistingCampaign(params)).toEqual({ id: "b", name: "B", postId: "p1", keywords: ["CLAUDE"] });
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", instagramAccountId: "acc_1", postId: "p1" },
      select: { id: true, name: true, postId: true, keywords: true, isActive: true },
    });

    mockPrisma.automation.findMany.mockResolvedValueOnce([{ id: "c", name: "C", postId: "p1", keywords: ["B", "A"] }]);
    expect((await findExistingCampaign({ ...params, keywords: ["a", "b"] }))?.id).toBe("c");
  });

  it("palavras diferentes ou conjunto diferente nao contam como a mesma campanha", async () => {
    mockPrisma.automation.findMany.mockResolvedValueOnce([{ id: "a", name: "A", postId: "p1", keywords: ["CLAUDE", "N8N"] }]);
    expect(await findExistingCampaign(params)).toBeNull();
    mockPrisma.automation.findMany.mockResolvedValueOnce([]);
    expect(await findExistingCampaign(params)).toBeNull();
  });
});
