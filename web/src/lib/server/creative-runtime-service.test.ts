import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
    getCreativeConversation: vi.fn(),
    getCreativeConversationsByIds: vi.fn(),
    registerCreativeAssets: vi.fn(),
    getLibraryAsset: vi.fn(),
    getLocalMediaRegistration: vi.fn(),
    registerLocalMediaAsset: vi.fn(),
    persistExternalMediaIfEnabled: vi.fn(),
    readExternalMediaBytes: vi.fn(),
    readReferenceAsset: vi.fn(),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    writePersistentMediaDataUrl: vi.fn(),
    deleteCreativeConversationAggregates: vi.fn(),
    deleteUserMediaAssetsCascade: vi.fn(),
}));

vi.mock("@/lib/server/creative-runtime-store", () => ({
    createCreativeConversation: vi.fn(),
    getCreativeAsset: vi.fn(),
    getCreativeConversation: mocks.getCreativeConversation,
    getCreativeConversationsByIds: mocks.getCreativeConversationsByIds,
    listCreativeAssets: vi.fn(),
    listCreativeConversations: vi.fn(),
    listCreativeMessages: vi.fn(),
    registerCreativeAssets: mocks.registerCreativeAssets,
    updateCreativeConversation: vi.fn(),
}));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.writePersistentMediaDataUrl, readReferenceAsset: mocks.readReferenceAsset }));
vi.mock("@/lib/server/creative-entity-deletion-store", () => ({ deleteCreativeConversationAggregates: mocks.deleteCreativeConversationAggregates }));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.deleteUserMediaAssetsCascade }));
vi.mock("@/lib/server/library-asset-store", () => ({ getLibraryAsset: mocks.getLibraryAsset }));
vi.mock("@/lib/server/local-media-registry", () => ({
    getLocalMediaRegistration: mocks.getLocalMediaRegistration,
    registerLocalMediaAsset: mocks.registerLocalMediaAsset,
}));
vi.mock("@/lib/server/object-storage-service", () => ({
    persistExternalMediaIfEnabled: mocks.persistExternalMediaIfEnabled,
    readExternalMediaBytes: mocks.readExternalMediaBytes,
}));
vi.mock("@/lib/server/data-dir", () => ({ resolveServerDataPath: vi.fn((name: string) => `data/${name}`) }));
vi.mock("@/lib/server/local-media-storage", () => ({
    createDatedMediaPath: vi.fn(() => "permanent/2026/01/01/images/new.png"),
    REFERENCE_MEDIA_ROOT: resolve(process.cwd(), "tmp/vozeb-pro-reference-assets"),
}));
vi.mock("node:fs/promises", () => ({
    copyFile: mocks.copyFile,
    mkdir: mocks.mkdir,
    stat: mocks.stat,
    unlink: mocks.unlink,
}));

import { deleteConversationsForUser, insertLibraryAssetForUser, registerGenerationTaskAssetsForUser, uploadAssetForUser } from "./creative-runtime-service";
import { REFERENCE_MEDIA_ROOT } from "@/lib/server/local-media-storage";

function file(name: string, type: string, size = 4): File {
    return { name, type, size, arrayBuffer: async () => new Uint8Array(Math.min(size, 4)).buffer } as File;
}

function libraryImageAsset() {
    return {
        id: "library-one",
        kind: "image",
        title: "库图片",
        source: "upload",
        note: "",
        tags: [],
        data: { dataUrl: "[image omitted]", storageKey: "permanent/source.png", mimeType: "image/png", bytes: 4, width: 10, height: 10 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
}

describe("创作会话素材上传", () => {
    beforeEach(() => {
        mocks.getCreativeConversation.mockReset().mockResolvedValue({ id: "conversation-one", userId: "user-one", surface: "chat", status: "active" });
        mocks.getCreativeConversationsByIds.mockReset().mockResolvedValue([{ id: "conversation-one", userId: "user-one", surface: "chat", status: "active" }]);
        mocks.writePersistentMediaDataUrl.mockReset().mockResolvedValue({ token: "persistent-one.mp4", storage: "local", bytes: 4, mimeType: "video/mp4" });
        mocks.deleteCreativeConversationAggregates.mockReset().mockResolvedValue({ deletedConversations: 1, deletedProjects: 0, mediaStorageKeys: ["permanent/one.png"] });
        mocks.deleteUserMediaAssetsCascade.mockReset().mockResolvedValue({ deletedFiles: 1, deletedBytes: 4, blocked: [] });
        mocks.registerCreativeAssets.mockReset().mockImplementation(async ([input]) => [{ ...input, id: "asset-one", status: "ready", metadata: input.metadata || {}, createdAt: 1, updatedAt: 1 }]);
        mocks.getLibraryAsset.mockReset().mockResolvedValue(null);
        mocks.getLocalMediaRegistration.mockReset().mockResolvedValue(null);
        mocks.registerLocalMediaAsset.mockReset().mockImplementation(async (input) => ({ ...input, createdAt: "2026-01-01T00:00:00.000Z" }));
        mocks.persistExternalMediaIfEnabled.mockReset().mockResolvedValue(null);
        mocks.readExternalMediaBytes.mockReset().mockResolvedValue(Buffer.from("image"));
        mocks.readReferenceAsset.mockReset().mockResolvedValue({ filePath: resolve(REFERENCE_MEDIA_ROOT, "permanent/source.png"), size: 4 });
        mocks.copyFile.mockReset().mockResolvedValue(undefined);
        mocks.mkdir.mockReset().mockResolvedValue(undefined);
        mocks.stat.mockReset().mockResolvedValue({ isFile: () => true });
        mocks.unlink.mockReset().mockResolvedValue(undefined);
    });

    it("hard-deletes conversations before reclaiming only their candidate media", async () => {
        await expect(deleteConversationsForUser("user-one", ["conversation-one", "conversation-one"])).resolves.toBe(1);

        expect(mocks.deleteCreativeConversationAggregates).toHaveBeenCalledWith("user-one", ["conversation-one"]);
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalledWith("user-one", ["permanent/one.png"]);
    });

    it("rejects deleting project conversations through the ordinary chat endpoint", async () => {
        mocks.getCreativeConversationsByIds.mockResolvedValue([{ id: "conversation-one", userId: "user-one", surface: "canvas", projectId: "canvas-one", status: "active" }]);

        await expect(deleteConversationsForUser("user-one", ["conversation-one"])).rejects.toMatchObject({ status: 409 });
        expect(mocks.deleteCreativeConversationAggregates).not.toHaveBeenCalled();
    });

    it("stores image, video and audio as stable assets without persisting base64", async () => {
        const asset = await uploadAssetForUser("user-one", "conversation-one", file("clip.mp4", "video/mp4"));

        expect(mocks.writePersistentMediaDataUrl).toHaveBeenCalledWith(
            expect.stringMatching(/^data:video\/mp4;base64,/),
            "video",
            expect.objectContaining({ ownerUserId: "user-one", conversationId: "conversation-one", originalName: "clip.mp4", maxBytes: 20 * 1024 * 1024 }),
        );
        expect(asset).toMatchObject({ id: "asset-one", type: "video", serverUrl: "/api/reference-assets/persistent-one.mp4", storageKey: "persistent-one.mp4" });
        expect(JSON.stringify(mocks.registerCreativeAssets.mock.calls[0][0])).not.toContain("base64");
    });

    it("keeps the internal storage key while marking object-backed uploads", async () => {
        mocks.writePersistentMediaDataUrl.mockResolvedValue({ token: "permanent/object.png", storage: "object", bytes: 4, mimeType: "image/png" });

        const asset = await uploadAssetForUser("user-one", "conversation-one", file("image.png", "image/png"));

        expect(asset).toMatchObject({ storageKind: "object", storageKey: "permanent/object.png", serverUrl: "/api/reference-assets/permanent/object.png" });
    });

    it("rejects unsupported files, oversized files and other users' conversations", async () => {
        await expect(uploadAssetForUser("user-one", "conversation-one", file("notes.pdf", "application/pdf"))).rejects.toMatchObject({ status: 400 });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("vector.svg", "image/svg+xml"))).rejects.toMatchObject({ status: 400 });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("limit.mp4", "video/mp4", 20 * 1024 * 1024))).resolves.toMatchObject({ id: "asset-one" });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("large.mp4", "video/mp4", 20 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
        mocks.getCreativeConversation.mockResolvedValueOnce({ id: "conversation-one", userId: "user-two", status: "active" });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("image.png", "image/png"))).rejects.toMatchObject({ status: 404 });
    });

    it("clones an owned library asset into a stable conversation reference", async () => {
        mocks.getLibraryAsset.mockResolvedValue(libraryImageAsset());
        mocks.getLocalMediaRegistration.mockResolvedValue({
            storageKey: "permanent/source.png",
            scope: "reference",
            storageClass: "permanent",
            type: "image",
            ownerUserId: "user-one",
            originalName: "source.png",
            source: "creative-upload",
            mimeType: "image/png",
            bytes: 4,
            storageProvider: "local",
            createdAt: "2026-01-01T00:00:00.000Z",
        });

        const asset = await insertLibraryAssetForUser("user-one", "conversation-one", "library-one");

        expect(mocks.copyFile).toHaveBeenCalledWith(resolve(REFERENCE_MEDIA_ROOT, "permanent/source.png"), resolve(REFERENCE_MEDIA_ROOT, "permanent/2026/01/01/images/new.png"));
        expect(mocks.registerLocalMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ storageKey: "permanent/2026/01/01/images/new.png", ownerUserId: "user-one", conversationId: "conversation-one", source: "creative-upload" }));
        expect(asset).toMatchObject({
            id: "asset-one",
            type: "image",
            sourceRunId: "library-insert",
            sourceTaskId: "permanent/2026/01/01/images/new.png",
            storageKind: "local",
            serverUrl: "/api/reference-assets/permanent/2026/01/01/images/new.png",
            metadata: { source: "library", libraryAssetId: "library-one" },
        });
    });

    it("rejects missing library assets and archived conversations", async () => {
        await expect(insertLibraryAssetForUser("user-one", "conversation-one", "missing-library")).rejects.toMatchObject({ status: 404 });

        mocks.getLibraryAsset.mockResolvedValue(libraryImageAsset());
        mocks.getCreativeConversation.mockResolvedValue({ id: "conversation-one", userId: "user-one", surface: "chat", status: "archived" });

        await expect(insertLibraryAssetForUser("user-one", "conversation-one", "library-one")).rejects.toMatchObject({ status: 409 });
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it("copies object-backed library media into object storage", async () => {
        const source = {
            storageKey: "permanent/source.png",
            scope: "reference",
            storageClass: "permanent",
            type: "image",
            ownerUserId: "user-one",
            source: "creative-upload",
            mimeType: "image/png",
            bytes: 4,
            storageProvider: "object",
            externalStorageId: "storage-one",
            externalObjectKey: "library/source.png",
            createdAt: "2026-01-01T00:00:00.000Z",
        };
        mocks.getLibraryAsset.mockResolvedValue(libraryImageAsset());
        mocks.getLocalMediaRegistration.mockResolvedValue(source);
        mocks.persistExternalMediaIfEnabled.mockResolvedValue({ storageKey: "permanent/2026/01/01/images/new.png", bytes: 4, mimeType: "image/png" });

        const asset = await insertLibraryAssetForUser("user-one", "conversation-one", "library-one");

        expect(mocks.readExternalMediaBytes).toHaveBeenCalledWith(source);
        expect(mocks.persistExternalMediaIfEnabled).toHaveBeenCalledWith(
            expect.objectContaining({
                registration: expect.objectContaining({ conversationId: "conversation-one", ownerUserId: "user-one", scope: "reference" }),
                bytes: Buffer.from("image"),
            }),
        );
        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(asset).toMatchObject({ storageKind: "object", storageKey: "permanent/2026/01/01/images/new.png" });
    });

    it("rejects a library asset that points to another user's media", async () => {
        mocks.getLibraryAsset.mockResolvedValue(libraryImageAsset());
        mocks.getLocalMediaRegistration.mockResolvedValue({
            storageKey: "permanent/source.png",
            scope: "reference",
            storageClass: "permanent",
            type: "image",
            ownerUserId: "user-two",
            source: "creative-upload",
            mimeType: "image/png",
            bytes: 4,
            storageProvider: "local",
            createdAt: "2026-01-01T00:00:00.000Z",
        });

        await expect(insertLibraryAssetForUser("user-one", "conversation-one", "library-one")).rejects.toMatchObject({ status: 400, message: "素材文件不存在" });
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it("registers unified Agent task media against the owned conversation", async () => {
        const assets = await registerGenerationTaskAssetsForUser("user-one", {
            conversationId: "conversation-one",
            runId: "run-one",
            surface: "chat",
            taskId: "task-one",
            title: "商品主图",
            assets: [{ type: "image", url: "/api/generation-log-assets/user/file.png", mimeType: "image/png", width: 1024, height: 1024 }],
        });

        expect(assets[0]).toMatchObject({ type: "image", serverUrl: "/api/generation-log-assets/user/file.png", storageKind: "local" });
        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([expect.objectContaining({ conversationId: "conversation-one", sourceRunId: "run-one", sourceTaskId: "task-one", metadata: { surface: "chat", projectId: undefined } })]);
    });
});
