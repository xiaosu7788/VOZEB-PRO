import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PaymentRuntimeConfig } from "@/lib/server/payment-config-store";

import { loadPaymentPrivateKey } from "./payment-signature-utils";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = keyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function config(values: Record<string, string>): PaymentRuntimeConfig {
    return { saved: { providers: {} }, providers: {}, valuesByEnvName: values };
}

function pemBody(pem: string) {
    return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

function canSign(key: string) {
    try {
        createSign("RSA-SHA256").update("fixture").sign(key, "base64");
        return true;
    } catch {
        return false;
    }
}

describe("payment private key loading", () => {
    it("keeps a PEM that already carries its own header", () => {
        expect(canSign(loadPaymentPrivateKey(config({ K: pkcs1Pem }), "K", "K_PATH"))).toBe(true);
        expect(canSign(loadPaymentPrivateKey(config({ K: pkcs8Pem }), "K", "K_PATH"))).toBe(true);
    });

    it("wraps a bare PKCS#1 body with the matching RSA PRIVATE KEY header", () => {
        // 商户后台常只给 base64 正文；一律套 PKCS#8 会报 DECODER routines::unsupported。
        const loaded = loadPaymentPrivateKey(config({ K: pemBody(pkcs1Pem) }), "K", "K_PATH");

        expect(loaded).toContain("-----BEGIN RSA PRIVATE KEY-----");
        expect(canSign(loaded)).toBe(true);
    });

    it("wraps a bare PKCS#8 body with the PRIVATE KEY header", () => {
        const loaded = loadPaymentPrivateKey(config({ K: pemBody(pkcs8Pem) }), "K", "K_PATH");

        expect(loaded).toContain("-----BEGIN PRIVATE KEY-----");
        expect(canSign(loaded)).toBe(true);
    });

    it("accepts escaped newlines and surrounding whitespace from environment variables", () => {
        const escaped = `  ${pkcs1Pem.trim().replace(/\n/g, "\\n")}  `;

        expect(canSign(loadPaymentPrivateKey(config({ K: escaped }), "K", "K_PATH"))).toBe(true);
    });

    it("rejects an empty key and a missing configuration", () => {
        // 仅转义换行的值能通过配置读取，但去掉换行后没有正文，落到“配置为空”分支。
        expect(() => loadPaymentPrivateKey(config({ K: "\\n\\n" }), "K", "K_PATH")).toThrow("支付私钥配置为空");
        // 空白值会被配置读取提前 trim 成空串，落到“缺少配置”分支。
        expect(() => loadPaymentPrivateKey(config({ K: "   " }), "K", "K_PATH")).toThrow("缺少支付私钥配置：K");
        expect(() => loadPaymentPrivateKey(config({}), "K", "K_PATH")).toThrow("缺少支付私钥配置：K");
    });
});
