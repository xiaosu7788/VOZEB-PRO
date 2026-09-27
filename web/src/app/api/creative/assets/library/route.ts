import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { CreativeRuntimeServiceError, insertLibraryAssetForUser } from "@/lib/server/creative-runtime-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<{ conversationId?: unknown; libraryAssetId?: unknown }>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
        const conversationId = String(body.conversationId || "").trim();
        const libraryAssetId = String(body.libraryAssetId || "").trim();
        if (!conversationId) throw new CreativeRuntimeServiceError("创作会话不能为空", 400);
        if (!libraryAssetId) throw new CreativeRuntimeServiceError("素材标识不能为空", 400);
        const asset = await insertLibraryAssetForUser(user.id, conversationId, libraryAssetId);
        return NextResponse.json({ code: 0, data: { asset }, msg: "素材已插入" });
    } catch (error) {
        if (error instanceof CreativeRuntimeServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
