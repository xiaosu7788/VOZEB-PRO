import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

import type { PublishedWorkAssetRecord } from "@/lib/server/database";
import { createDatedMediaPath, REFERENCE_MEDIA_ROOT } from "@/lib/server/local-media-storage";
import { deleteLocalMediaRegistrations, getLocalMediaRegistration, registerLocalMediaAsset, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { deleteExternalMediaObject, persistExternalMediaIfEnabled, readExternalMediaBytes } from "@/lib/server/object-storage-service";
import { readReferenceAsset } from "@/lib/server/reference-asset-store";
import { resolveServerDataPath } from "@/lib/server/data-dir";

export async function clonePublishedWorkAssets(ownerUserId: string, workId: string, assets: PublishedWorkAssetRecord[]) {
    const clonedKeys: string[] = [];
    try {
        const cloned = [];
        for (const asset of assets) {
            const source = await getLocalMediaRegistration(asset.storageKey);
            if (!source) throw new Error("公开作品媒体不存在，无法创建专属副本");
            const copy = await clonePublishedWorkMedia(source, ownerUserId, workId);
            clonedKeys.push(copy.storageKey);
            cloned.push({ ...asset, storageKey: copy.storageKey, mimeType: copy.mimeType, metadata: { originalName: copy.originalName || source.originalName || asset.storageKey.split("/").at(-1) || "媒体", bytes: copy.bytes }, createdAt: new Date().toISOString() });
        }
        return { assets: cloned, storageKeys: clonedKeys };
    } catch (error) {
        await deletePublishedWorkMediaFiles(clonedKeys);
        throw error;
    }
}

export async function deletePublishedWorkMediaFiles(storageKeys: string[]) {
    for (const storageKey of Array.from(new Set(storageKeys.filter(Boolean)))) {
        const registration = await getLocalMediaRegistration(storageKey);
        if (!registration || registration.source !== "published-work") continue;
        if (registration.storageProvider === "object") {
            await deleteExternalMediaObject(registration);
        } else {
            const filePath = safeReferencePath(storageKey);
            if (filePath) await unlink(filePath).catch(() => undefined);
        }
        await deleteLocalMediaRegistrations([storageKey]);
    }
}

async function clonePublishedWorkMedia(source: LocalMediaRegistration, ownerUserId: string, workId: string) {
    const extension = extname(source.storageKey).toLowerCase() || ".bin";
    const storageKey = createDatedMediaPath("permanent", source.type, extension);
    const registration = {
        storageKey,
        scope: "reference" as const,
        storageClass: "permanent" as const,
        type: source.type,
        ownerUserId,
        originalName: source.originalName,
        source: "published-work",
        projectId: workId,
        mimeType: source.mimeType,
        bytes: source.bytes,
    };

    if (source.storageProvider === "object") {
        const external = await persistExternalMediaIfEnabled({ registration, bytes: await readExternalMediaBytes(source) });
        if (!external) throw new Error("公开作品媒体无法复制到本地存储");
        return external;
    }

    const sourcePath = await localMediaPath(source);
    const targetPath = safeReferencePath(storageKey);
    if (!sourcePath || !targetPath) throw new Error("公开作品媒体路径无效");
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    try {
        return await registerLocalMediaAsset(registration);
    } catch (error) {
        await unlink(targetPath).catch(() => undefined);
        throw error;
    }
}

async function localMediaPath(registration: LocalMediaRegistration) {
    if (registration.scope === "reference") return (await readReferenceAsset(registration.storageKey))?.filePath || null;
    const root = resolveServerDataPath("generation-assets");
    const filePath = resolve(root, registration.storageKey);
    if (filePath === root || !filePath.startsWith(`${root}${sep}`)) return null;
    const info = await stat(filePath).catch(() => null);
    return info?.isFile() ? filePath : null;
}

function safeReferencePath(storageKey: string) {
    const filePath = resolve(REFERENCE_MEDIA_ROOT, storageKey);
    return filePath === REFERENCE_MEDIA_ROOT || !filePath.startsWith(`${REFERENCE_MEDIA_ROOT}${sep}`) ? null : filePath;
}
