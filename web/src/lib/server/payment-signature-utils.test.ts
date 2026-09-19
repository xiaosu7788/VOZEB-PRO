import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PaymentRuntimeConfig } from "@/lib/server/payment-config-store";

import { loadPaymentPrivateKey, loadPaymentPublicKey, verifyRsaSha256 } from "./payment-signature-utils";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = keyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const spkiPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const pkcs1PublicPem = keyPair.publicKey.export({ type: "pkcs1", format: "pem" }).toString();

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

    describe("payment public key loading", () => {
        const content = "vozeb-pro-fixture";
        const signature = createSign("RSA-SHA256").update(content, "utf8").sign(pkcs1Pem, "base64");

        it("keeps a PEM that already carries its own header", () => {
            const key = loadPaymentPublicKey(config({ K: spkiPem }), "K", "K_PATH");

            expect(verifyRsaSha256(content, signature, key)).toBe(true);
        });

        it("wraps a bare SPKI body with the PUBLIC KEY header", () => {
            const key = loadPaymentPublicKey(config({ K: pemBody(spkiPem) }), "K", "K_PATH");

            expect(key).toContain("-----BEGIN PUBLIC KEY-----");
            expect(verifyRsaSha256(content, signature, key)).toBe(true);
        });

        it("wraps a bare PKCS#1 body with the matching RSA PUBLIC KEY header", () => {
            // 平台常只给 base64 正文；一律套 SPKI 会让 PKCS#1 公钥整体验签失败。
            const key = loadPaymentPublicKey(config({ K: pemBody(pkcs1PublicPem) }), "K", "K_PATH");

            expect(key).toContain("-----BEGIN RSA PUBLIC KEY-----");
            expect(verifyRsaSha256(content, signature, key)).toBe(true);
        });

        it("rejects an empty key and a missing configuration", () => {
            expect(() => loadPaymentPublicKey(config({ K: "\\n" }), "K", "K_PATH")).toThrow("支付公钥配置为空");
            expect(() => loadPaymentPublicKey(config({}), "K", "K_PATH")).toThrow("缺少支付公钥配置：K");
        });
    });
});
