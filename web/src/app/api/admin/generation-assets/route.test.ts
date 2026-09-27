import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    readJsonBodyResult: vi.fn(),
    hasAdminPermission: vi.fn(),
    registrations: vi.fn(),
    cascade: vi.fn(),
    direct: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/request", () => ({ readJsonBodyResult: mocks.readJsonBodyResult }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminPermission: mocks.hasAdminPermission }));
vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistrations: mocks.registrations }));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.cascade }));
vi.mock("@/lib/server/local-media-storage", () => ({
    cleanupExpiredLocalMediaAssets: vi.fn(),
    deleteLocalMediaAssets: mocks.direct,
    decodeLocalMediaId: (id: string) => (id === "owned" ? { scope: "reference", relativePath: "permanent/owned.png" } : null),
    getLocalMediaAssetSummary: vi.fn(),
    listLocalMediaAssets: vi.fn(),
}));
vi.mock("@/lib/auth/store", () => ({ findPublicUserIdsByKeyword: vi.fn(), getPublicUsersByIds: vi.fn() }));

import { DELETE } from "./route";

describe("admin generation asset deletion", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "admin-one" });
        mocks.hasAdminPermission.mockReturnValue(true);
        mocks.readJsonBodyResult.mockResolvedValue({ ok: true, data: { ids: ["owned"] } });
        mocks.registrations.mockResolvedValue([{ storageKey: "permanent/owned.png", ownerUserId: "user-one" }]);
        mocks.cascade.mockResolvedValue({ deletedFiles: 1, deletedBytes: 8, removedReferences: 3, blocked: [] });
    });

    it("uses administrator cascade deletion for owned media", async () => {
        const response = await DELETE(new Request("http://localhost/api/admin/generation-assets", { method: "DELETE" }));

        expect(response.status).toBe(200);
        expect(mocks.cascade).toHaveBeenCalledWith("user-one", ["permanent/owned.png"]);
        expect(mocks.direct).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toMatchObject({ data: { deletedFiles: 1, removedReferences: 3 } });
    });
});
