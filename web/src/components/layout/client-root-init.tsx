"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { App } from "antd";
import { usePathname } from "next/navigation";

import { SiteAnnouncementPopup } from "@/components/layout/site-announcement-popup";
import { applyPublicSystemSettings, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { loadPublicSession, PUBLIC_SETTINGS_CHANGED_EVENT } from "@/stores/use-public-session-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const installRoute = pathname === "/install";
    const setConfig = useConfigStore((state) => state.setConfig);
    const setUser = useUserStore((state) => state.setUser);
    const mountedRef = useRef(true);
    const hydrateRevisionRef = useRef(0);
    const previousPathnameRef = useRef(pathname);

    const hydrate = useCallback(
        (force = false) => {
            const revision = ++hydrateRevisionRef.current;
            void loadPublicSession({ force })
                .then((payload) => {
                    if (!mountedRef.current || revision !== hydrateRevisionRef.current) return;
                    setUser(payload.user || null);
                    setConfig(applyPublicSystemSettings(useConfigStore.getState().config, payload.settings));
                })
                .catch(() => undefined);
        },
        [setConfig, setUser],
    );

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            hydrateRevisionRef.current += 1;
        };
    }, []);

    useEffect(() => {
        if (installRoute) return;
        hydrate();
        const handleSettingsChanged = () => hydrate(true);
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") hydrate(true);
        };
        window.addEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [hydrate, installRoute]);

    useEffect(() => {
        const previousPathname = previousPathnameRef.current;
        previousPathnameRef.current = pathname;
        if (installRoute || pathname.startsWith("/admin") || !previousPathname.startsWith("/admin")) return;
        hydrate(true);
    }, [hydrate, installRoute, pathname]);

    useEffect(() => {
        const handleMissingConfig = () => {
            message.warning("请联系管理员在后台配置可用模型渠道");
        };
        window.addEventListener("vozeb-pro-system-config-missing", handleMissingConfig);
        return () => window.removeEventListener("vozeb-pro-system-config-missing", handleMissingConfig);
    }, [message]);

    return (
        <>
            {children}
            {installRoute ? null : <SiteAnnouncementPopup />}
        </>
    );
}
