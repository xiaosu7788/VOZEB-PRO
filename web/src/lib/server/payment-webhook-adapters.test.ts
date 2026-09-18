import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { PaymentRuntimeConfig } from "./payment-config-store";
import { resolveWebhookAdapter } from "./payment-webhook-adapters";

const alipayKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const alipayPublicKey = alipayKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const dulupayKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dulupayPublicKey = dulupayKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("Alipay payment webhook adapter", () => {
    it("verifies and parses the shared official/face-to-face callback", () => {
        const params = signedAlipayCallback();
        const parsed = resolveWebhookAdapter("alipay").parse("alipay", params.toString(), new Headers(), alipayConfig());

        expect(parsed).toMatchObject({
            signatureValid: true,
            status: "succeeded",
            eventType: "alipay.trade_success",
            orderId: "order-one",
            orderNo: "VZ001",
            providerTradeId: "2026072800000001",
            amountCents: 1299,
            currency: "CNY",
        });
    });

    it("rejects callback data changed after signing", () => {
        const params = signedAlipayCallback();
        params.set("total_amount", "0.01");

        const parsed = resolveWebhookAdapter("alipay").parse("alipay", params.toString(), new Headers(), alipayConfig());

        expect(parsed.signatureValid).toBe(false);
    });
});

function signedAlipayCallback() {
    const params = new URLSearchParams({
        app_id: "2026000000000000",
        sign_type: "RSA2",
        notify_id: "notify-one",
        trade_no: "2026072800000001",
        trade_status: "TRADE_SUCCESS",
        out_trade_no: "VZ001",
        passback_params: encodeURIComponent("order-one"),
        total_amount: "12.99",
        gmt_payment: "2026-07-28 16:20:00",
    });
    const content = [...params.entries()]
        .filter(([key, value]) => key !== "sign_type" && value !== "")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    params.set("sign", createSign("RSA-SHA256").update(content, "utf8").sign(alipayKeyPair.privateKey, "base64"));
    return params;
}

function alipayConfig(): PaymentRuntimeConfig {
    return {
        saved: { providers: {} },
        providers: { alipay: { enabled: true, saved: true } },
        valuesByEnvName: {
            VOZEB_PRO_ALIPAY_MODE: "face_to_face",
            VOZEB_PRO_ALIPAY_APP_ID: "2026000000000000",
            VOZEB_PRO_ALIPAY_PUBLIC_KEY: alipayPublicKey,
        },
    };
}

describe("Dulupay payment webhook adapter", () => {
    it("verifies and parses the GET notify callback including extra fields", () => {
        const params = signedDulupayCallback({ trade_status: "TRADE_SUCCESS" });
        const parsed = resolveWebhookAdapter("dulupay").parse("dulupay", params.toString(), new Headers(), dulupayConfig());

        expect(parsed).toMatchObject({
            eventId: "2026072800000001:TRADE_SUCCESS",
            signatureValid: true,
            status: "succeeded",
            eventType: "dulupay.alipay",
            orderNo: "VZ001",
            providerTradeId: "2026072800000001",
            providerPaymentId: "40001249985198893",
            amountCents: 1299,
            currency: "CNY",
        });
    });

    it("ignores non-success trade status and rejects tampered amounts", () => {
        const pending = resolveWebhookAdapter("dulupay").parse("dulupay", signedDulupayCallback({ trade_status: "TRADE_PENDING" }).toString(), new Headers(), dulupayConfig());
        expect(pending).toMatchObject({ signatureValid: true, status: "ignored" });

        const tampered = signedDulupayCallback({ trade_status: "TRADE_SUCCESS" });
        tampered.set("money", "0.01");
        expect(resolveWebhookAdapter("dulupay").parse("dulupay", tampered.toString(), new Headers(), dulupayConfig()).signatureValid).toBe(false);
    });
});

function signedDulupayCallback(overrides: Record<string, string>) {
    const params = new URLSearchParams({
        pid: "1001",
        trade_no: "2026072800000001",
        out_trade_no: "VZ001",
        api_trade_no: "40001249985198893",
        type: "alipay",
        name: "Pro plan",
        money: "12.99",
        addtime: "2026-07-28 16:20:00",
        endtime: "2026-07-28 16:22:00",
        timestamp: "1785318000",
        sign_type: "RSA",
        ...overrides,
    });
    const content = [...params.entries()]
        .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    params.set("sign", createSign("RSA-SHA256").update(content, "utf8").sign(dulupayKeyPair.privateKey, "base64"));
    return params;
}

function dulupayConfig(): PaymentRuntimeConfig {
    return {
        saved: { providers: {} },
        providers: { dulupay: { enabled: true, saved: true } },
        valuesByEnvName: {
            VOZEB_PRO_DULUPAY_PID: "1001",
            VOZEB_PRO_DULUPAY_PUBLIC_KEY: dulupayPublicKey,
        },
    };
}
