import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    insertLibraryAssetForUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/creative-runtime-service", () => ({
    CreativeRuntimeServiceError: class CreativeRuntimeServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    insertLibraryAssetForUser: mocks.insertLibraryAssetForUser,
}));

import { CreativeRuntimeServiceError } from "@/lib/server/creative-runtime-service";
import { POST } from "./route";

describe("POST /api/creative/assets/library", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.insertLibraryAssetForUser.mockResolvedValue({ id: "asset-one", type: "image" });
    });

    it("requires authentication", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await POST(request({ conversationId: "conversation-one", libraryAssetId: "library-one" }));

        expect(response.status).toBe(401);
        expect(mocks.insertLibraryAssetForUser).not.toHaveBeenCalled();
    });

    it("returns a client error for malformed JSON", async () => {
        const response = await POST(new Request("http://localhost/api/creative/assets/library", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 400, data: null });
        expect(mocks.insertLibraryAssetForUser).not.toHaveBeenCalled();
    });

    it("requires both identifiers before calling the service", async () => {
        const response = await POST(request({ conversationId: "conversation-one" }));

        expect(response.status).toBe(400);
        expect(mocks.insertLibraryAssetForUser).not.toHaveBeenCalled();
    });

    it("inserts the owned library media into the requested conversation", async () => {
        const response = await POST(request({ conversationId: "conversation-one", libraryAssetId: "library-one" }));

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { asset: { id: "asset-one" } }, msg: "素材已插入" });
        expect(mocks.insertLibraryAssetForUser).toHaveBeenCalledWith("user-one", "conversation-one", "library-one");
    });

    it("maps service errors to their HTTP status", async () => {
        mocks.insertLibraryAssetForUser.mockRejectedValue(new CreativeRuntimeServiceError("素材不存在", 404));

        const response = await POST(request({ conversationId: "conversation-one", libraryAssetId: "missing" }));

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 404, msg: "素材不存在" });
    });
});

function request(body: unknown) {
    return new Request("http://localhost/api/creative/assets/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}
