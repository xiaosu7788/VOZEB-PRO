import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));

import type { BillingOrderRecord } from "@/lib/server/database";
import type { PaymentRuntimeConfig } from "@/lib/server/payment-config-store";
import { checkoutFromMetadata, checkoutMetadata, createProviderCheckout } from "./payment-checkout-providers";

const order = {
    id: "order-one",
    orderNo: "VZ001",
    productId: "product",
    userId: "user",
    productKind: "plan",
    planId: "pro",
    status: "pending",
    subject: "Pro",
    listAmountCents: 1299,
    promotionDiscountCents: 0,
    couponDiscountCents: 0,
    amountCents: 1299,
    currency: "USD",
    pointsAmount: 100,
    dailyPoints: 20,
    periodDays: 30,
    quantity: 1,
    provider: "stripe",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies BillingOrderRecord;

const config: PaymentRuntimeConfig = {
    saved: { providers: {} },
    providers: {},
    valuesByEnvName: {
        VOZEB_PRO_STRIPE_SECRET_KEY: "sk_test_secret",
        VOZEB_PRO_STRIPE_API_BASE: "https://stripe.test",
    },
};

const alipayKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const alipayPrivateKey = alipayKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const alipayPublicKey = alipayKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const dulupayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dulupayPrivateKey = dulupayKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const dulupayPublicKey = dulupayKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("payment checkout providers", () => {
    beforeEach(() => vi.unstubAllGlobals());

    it("uses a stable Stripe idempotency key for one local order", async () => {
        const fetchMock = vi.fn(async () => Response.json({ id: "cs_test_session", url: "https://checkout.stripe.test/session", expires_at: 4070908800 }));
        vi.stubGlobal("fetch", fetchMock);

        await createProviderCheckout("stripe", order, { origin: "https://app.test" }, config);

        expect(fetchMock).toHaveBeenCalledWith(
            "https://stripe.test/v1/checkout/sessions",
            expect.objectContaining({
                headers: expect.objectContaining({ "Idempotency-Key": "vozeb-pro-checkout-order-one" }),
            }),
        );
    });

    it("restores a reusable checkout result from order metadata", () => {
        const checkout = {
            provider: "stripe",
            orderId: order.id,
            orderNo: order.orderNo,
            kind: "redirect" as const,
            url: "https://checkout.stripe.test/session",
            providerOrderId: "cs_test_session",
            expiresAt: "2099-01-01T00:00:00.000Z",
        };

        expect(checkoutFromMetadata({ ...order, metadata: { checkout: checkoutMetadata(checkout) } }, "stripe")).toEqual(checkout);
    });

    it("uses the Alipay official page-pay flow by default", async () => {
        const checkout = await createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, { origin: "https://app.test" }, alipayConfig());
        const params = new URL(checkout.url || "").searchParams;

        expect(checkout).toMatchObject({ provider: "alipay", kind: "form", providerOrderId: order.orderNo });
        expect(params.get("method")).toBe("alipay.trade.page.pay");
        expect(params.get("return_url")).toBe(`https://app.test/billing/success?orderId=${order.id}`);
        expect(JSON.parse(params.get("biz_content") || "{}")).toMatchObject({ out_trade_no: order.orderNo, total_amount: "12.99", product_code: "FAST_INSTANT_TRADE_PAY" });
    });

    it("creates an Alipay face-to-face QR checkout", async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
            signedAlipayResponse({
                alipay_trade_precreate_response: {
                    code: "10000",
                    msg: "Success",
                    out_trade_no: order.orderNo,
                    qr_code: "https://qr.alipay.test/order-one",
                },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const checkout = await createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, { origin: "https://app.test" }, alipayConfig("face_to_face"));

        expect(checkout).toMatchObject({ provider: "alipay", kind: "qr", qrContent: "https://qr.alipay.test/order-one", url: "https://qr.alipay.test/order-one", providerOrderId: order.orderNo });
        expect(fetchMock).toHaveBeenCalledWith("https://alipay.test/gateway.do", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded" }) }));
        const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
        expect(body.get("method")).toBe("alipay.trade.precreate");
        expect(body.get("notify_url")).toBe("https://app.test/api/billing/webhooks/alipay");
        expect(body.has("return_url")).toBe(false);
        expect(JSON.parse(body.get("biz_content") || "{}")).toMatchObject({ out_trade_no: order.orderNo, total_amount: "12.99", product_code: "FACE_TO_FACE_PAYMENT" });
        expect(verifyAlipayRequestSignature(body)).toBe(true);
    });

    it("returns the Alipay business error for a rejected face-to-face order", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    alipay_trade_precreate_response: { code: "40004", msg: "Business Failed", sub_code: "ACQ.INVALID_PARAMETER", sub_msg: "订单参数无效" },
                }),
            ),
        );

        await expect(createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, {}, alipayConfig("face_to_face"))).rejects.toThrow("订单参数无效");
    });

    it("rejects a successful Alipay response without a QR code", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => signedAlipayResponse({ alipay_trade_precreate_response: { code: "10000", msg: "Success", out_trade_no: order.orderNo } })),
        );

        await expect(createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, {}, alipayConfig("face_to_face"))).rejects.toThrow("支付宝当面付未返回有效二维码");
    });

    it("rejects a face-to-face QR response for another merchant order", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => signedAlipayResponse({ alipay_trade_precreate_response: { code: "10000", msg: "Success", out_trade_no: "VZ-OTHER", qr_code: "https://qr.alipay.test/other" } })),
        );

        await expect(createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, {}, alipayConfig("face_to_face"))).rejects.toThrow("支付宝当面付返回的订单号不匹配");
    });

    it("rejects non-CNY Alipay orders before sending an upstream request", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "USD" }, {}, alipayConfig("face_to_face"))).rejects.toThrow("支付宝仅支持人民币 CNY 订单");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an Alipay face-to-face response changed after signing", async () => {
        const response = signedAlipayResponse({ alipay_trade_precreate_response: { code: "10000", msg: "Success", out_trade_no: order.orderNo, qr_code: "https://qr.alipay.test/order-one" } });
        const rawBody = (await response.text()).replace("order-one", "changed-order");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(rawBody, { headers: { "content-type": "application/json" } })),
        );

        await expect(createProviderCheckout("alipay", { ...order, provider: "alipay", currency: "CNY" }, {}, alipayConfig("face_to_face"))).rejects.toThrow("支付宝当面付响应验签失败");
    });

    it("maps Dulupay pay_type values to redirect, QR and form checkouts", async () => {
        for (const [payType, expected] of [
            ["jump", { kind: "redirect", url: "https://pay.dulupay.test/jump" }],
            ["qrcode", { kind: "qr", qrContent: "https://pay.dulupay.test/jump" }],
            ["html", { kind: "form" }],
        ] as const) {
            const payInfo = payType === "html" ? '<form action="https://pay.dulupay.test/form" method="POST"><input name="token" value="fixture" /></form>' : "https://pay.dulupay.test/jump";
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => signedDulupayResponse({ code: 0, trade_no: "dulupay_trade", pay_type: payType, pay_info: payInfo })),
            );

            const checkout = await createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, { clientIp: "203.0.113.10" }, dulupayConfig());
            expect(checkout).toMatchObject({ providerOrderId: "dulupay_trade", ...expected });
        }
    });

    it("rejects Dulupay orders without a client IP and non-CNY orders before requesting upstream", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, {}, dulupayConfig())).rejects.toThrow("无法确定下单用户 IP");
        await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "USD" }, { clientIp: "203.0.113.10" }, dulupayConfig())).rejects.toThrow("嘟噜支付仅支持人民币 CNY 订单");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a Dulupay checkout response changed after signing", async () => {
        const response = signedDulupayResponse({ code: 0, trade_no: "dulupay_trade", pay_type: "qrcode", pay_info: "https://pay.dulupay.test/order-one" });
        const rawBody = (await response.text()).replace("order-one", "changed-order");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(rawBody, { headers: { "content-type": "application/json" } })),
        );

        await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, { clientIp: "203.0.113.10" }, dulupayConfig())).rejects.toThrow("嘟噜支付下单响应验签失败");
    });

    it("rejects unsupported Dulupay pay types with an actionable message", async () => {
        for (const [payType, payInfo] of [
            ["jsapi", '{"appId":"wx"}'],
            ["urlscheme", "weixin://wxpay/bizpayurl?pr=fixture"],
            ["app", "{}"],
        ] as const) {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => signedDulupayResponse({ code: 0, trade_no: "dulupay_trade", pay_type: payType, pay_info: payInfo })),
            );

            await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, { clientIp: "203.0.113.10" }, dulupayConfig())).rejects.toThrow("嘟噜支付返回的发起支付类型不受支持");
        }
    });

    it("truncates the Dulupay product name by code point so emoji never break the signature", async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => signedDulupayResponse({ code: 0, trade_no: "dulupay_trade", pay_type: "qrcode", pay_info: "https://pay.dulupay.test/qr" }));
        vi.stubGlobal("fetch", fetchMock);
        // 127 个 emoji 共 254 个 UTF-16 码元，按码点截断必须保留完整代理对。
        const subject = "😀".repeat(127);

        await createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY", subject }, { clientIp: "203.0.113.10" }, dulupayConfig());

        const body = new URLSearchParams(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
        const name = body.get("name") || "";
        expect(Array.from(name)).toHaveLength(127);
        expect(name).toBe(subject);
        expect(name.isWellFormed()).toBe(true);
    });

    it("rejects invalid Dulupay method and type configuration instead of silently defaulting", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const options = { clientIp: "203.0.113.10" };

        await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, options, dulupayConfig({ VOZEB_PRO_DULUPAY_METHOD: "wap" }))).rejects.toThrow("嘟噜支付接口类型配置无效");
        await expect(createProviderCheckout("dulupay", { ...order, provider: "dulupay", currency: "CNY" }, options, dulupayConfig({ VOZEB_PRO_DULUPAY_TYPE: "wx" }))).rejects.toThrow("嘟噜支付方式配置无效");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

function alipayConfig(mode = "official"): PaymentRuntimeConfig {
    return {
        saved: { providers: {} },
        providers: { alipay: { enabled: true, saved: true } },
        valuesByEnvName: {
            VOZEB_PRO_ALIPAY_MODE: mode,
            VOZEB_PRO_ALIPAY_APP_ID: "2026000000000000",
            VOZEB_PRO_ALIPAY_PRIVATE_KEY: alipayPrivateKey,
            VOZEB_PRO_ALIPAY_PUBLIC_KEY: alipayPublicKey,
            VOZEB_PRO_ALIPAY_GATEWAY_URL: "https://alipay.test/gateway.do",
        },
    };
}

function signedAlipayResponse(payload: { alipay_trade_precreate_response: Record<string, unknown> }) {
    const signContent = JSON.stringify(payload.alipay_trade_precreate_response);
    const sign = createSign("RSA-SHA256").update(signContent, "utf8").sign(alipayPrivateKey, "base64");
    return new Response(JSON.stringify({ ...payload, sign }), { headers: { "content-type": "application/json" } });
}

function dulupayConfig(overrides: Record<string, string> = {}): PaymentRuntimeConfig {
    return {
        saved: { providers: {} },
        providers: { dulupay: { enabled: true, saved: true } },
        valuesByEnvName: {
            VOZEB_PRO_DULUPAY_PID: "1001",
            VOZEB_PRO_DULUPAY_PRIVATE_KEY: dulupayPrivateKey,
            VOZEB_PRO_DULUPAY_PUBLIC_KEY: dulupayPublicKey,
            VOZEB_PRO_DULUPAY_GATEWAY_URL: "https://api.dulupay.test",
            ...overrides,
        },
    };
}

function signedDulupayResponse(payload: Record<string, unknown>) {
    const content = Object.keys(payload)
        .filter((key) => payload[key] !== "" && payload[key] !== undefined && payload[key] !== null)
        .sort()
        .map((key) => `${key}=${payload[key]}`)
        .join("&");
    const sign = createSign("RSA-SHA256").update(content, "utf8").sign(dulupayPrivateKey, "base64");
    return new Response(JSON.stringify({ ...payload, sign_type: "RSA", sign }), { headers: { "content-type": "application/json" } });
}

function verifyAlipayRequestSignature(body: URLSearchParams) {
    const content = [...body.entries()]
        .filter(([key, value]) => key !== "sign" && value !== "")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    return createVerify("RSA-SHA256")
        .update(content, "utf8")
        .verify(alipayKeyPair.publicKey, body.get("sign") || "", "base64");
}
