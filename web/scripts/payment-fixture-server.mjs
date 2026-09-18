import { createSign, createVerify } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function createPaymentFixtureServer(options = {}) {
    const requests = [];
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
            const body = await readRequestBody(request);
            requests.push({ method: request.method || "GET", path: url.pathname, headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value || ""])), body });
            await handlePaymentRequest({ request, response, url, body, options });
        } catch (error) {
            sendJson(response, 500, { error: { message: error instanceof Error ? error.message : "payment fixture failed" } });
        }
    });
    return { server, requests };
}

async function handlePaymentRequest({ request, response, url, body, options }) {
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/payply/query") {
        return sendJson(response, 200, {
            data: {
                status: "succeeded",
                orderId: url.searchParams.get("orderId") || "",
                orderNo: url.searchParams.get("orderNo") || "",
                tradeId: url.searchParams.get("tradeId") || "payply_trade_fixture",
                paymentId: url.searchParams.get("paymentId") || "payply_payment_fixture",
                amountCents: 100,
                currency: "CNY",
                paidAt: new Date().toISOString(),
            },
        });
    }
    if (request.method === "GET" && url.pathname === "/payply/refund-query") return sendJson(response, 200, { data: { status: "succeeded", refundId: url.searchParams.get("refundId") || "payply_refund_fixture" } });
    if (request.method !== "POST") return sendJson(response, 405, { error: { message: "method not allowed" } });
    if (url.pathname === "/stripe/v1/checkout/sessions") return sendJson(response, 200, { id: "cs_fixture", url: "https://checkout.fixture/stripe", expires_at: Math.floor(Date.now() / 1000) + 1800 });
    if (url.pathname === "/stripe/v1/refunds") return sendJson(response, 200, { id: "re_fixture", status: "succeeded" });
    if (url.pathname === "/wechat/v3/pay/transactions/native") return sendJson(response, 200, { code_url: "weixin://wxpay/bizpayurl?pr=fixture" });
    if (url.pathname === "/wechat/v3/refund/domestic/refunds") return sendSignedWechat(response, { refund_id: "wx_refund_fixture", status: "SUCCESS" }, options.wechatPrivateKey);
    if (url.pathname === "/payply/checkout") return sendJson(response, 200, { data: { paymentUrl: "https://checkout.fixture/payply", tradeId: "payply_trade_fixture", paymentId: "payply_payment_fixture" } });
    if (url.pathname === "/payply/refund") return sendJson(response, 200, { data: { status: "success", refundId: "payply_refund_fixture" } });
    if (url.pathname === "/dulupay/api/pay/create") return handleDulupayCreate(response, body, options);
    if (url.pathname === "/dulupay/api/pay/query") return handleDulupayQuery(response, body, options);
    if (url.pathname === "/dulupay/api/pay/refund") return handleDulupayRefund(response, body, options);
    if (url.pathname === "/alipay/gateway.do") return handleAlipay(response, body, options.alipayPrivateKey);
    return sendJson(response, 404, { error: { message: `payment fixture route not found: ${url.pathname}` } });
}

function handleAlipay(response, body, privateKey) {
    if (!privateKey) throw new Error("Alipay fixture private key is required");
    const params = new URLSearchParams(body.toString("utf8"));
    const bizContent = parseObject(params.get("biz_content"));
    if (params.get("method") === "alipay.trade.precreate") {
        const result = { code: "10000", msg: "Success", out_trade_no: bizContent.out_trade_no, trade_no: "alipay_trade_fixture", qr_code: "https://checkout.fixture/alipay-qr" };
        return sendSignedAlipay(response, "alipay_trade_precreate_response", result, privateKey);
    }
    if (params.get("method") === "alipay.trade.refund") {
        const result = { code: "10000", msg: "Success", out_trade_no: bizContent.out_trade_no, trade_no: bizContent.trade_no, out_request_no: bizContent.out_request_no };
        return sendSignedAlipay(response, "alipay_trade_refund_response", result, privateKey);
    }
    return sendJson(response, 400, { error: { message: "unsupported Alipay method" } });
}

function sendSignedAlipay(response, key, result, privateKey) {
    const sign = createSign("RSA-SHA256").update(JSON.stringify(result), "utf8").sign(privateKey, "base64");
    sendJson(response, 200, { [key]: result, sign });
}

function sendSignedWechat(response, result, privateKey) {
    if (!privateKey) throw new Error("WeChat fixture private key is required");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "wechat-fixture-response";
    const rawBody = JSON.stringify(result);
    const signature = createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8").sign(privateKey, "base64");
    sendJson(response, 200, result, {
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": nonce,
        "wechatpay-signature": signature,
        "wechatpay-serial": "fixture-platform-serial",
    });
}

async function readRequestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function parseObject(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function sendJson(response, status, value, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", ...headers });
    response.end(bytes);
}

function handleDulupayCreate(response, body, options) {
    if (!options.dulupayPrivateKey) throw new Error("Dulupay fixture private key is required");
    const params = verifyDulupayRequest(body, options);
    return sendSignedDulupay(response, options.dulupayPrivateKey, { code: 0, trade_no: "dulupay_trade_fixture", pay_type: "qrcode", pay_info: "https://checkout.fixture/dulupay-qr", out_trade_no: params.out_trade_no });
}

function handleDulupayQuery(response, body, options) {
    if (!options.dulupayPrivateKey) throw new Error("Dulupay fixture private key is required");
    const params = verifyDulupayRequest(body, options);
    return sendSignedDulupay(response, options.dulupayPrivateKey, {
        code: 0,
        trade_no: params.trade_no || "dulupay_trade_fixture",
        out_trade_no: params.out_trade_no || "VZ-LIVE-001",
        api_trade_no: "dulupay_api_trade_fixture",
        type: "alipay",
        status: 1,
        money: "12.99",
        endtime: "2026-07-01 16:49:24",
    });
}

function handleDulupayRefund(response, body, options) {
    if (!options.dulupayPrivateKey) throw new Error("Dulupay fixture private key is required");
    const params = verifyDulupayRequest(body, options);
    return sendSignedDulupay(response, options.dulupayPrivateKey, {
        code: 0,
        msg: "退款成功",
        refund_no: "dulupay_refund_fixture",
        out_refund_no: params.out_refund_no || "",
        trade_no: params.trade_no || "dulupay_trade_fixture",
        money: params.money || "12.99",
    });
}

function sendSignedDulupay(response, privateKey, payload) {
    const content = Object.keys(payload)
        .filter((key) => payload[key] !== "" && payload[key] !== undefined && payload[key] !== null)
        .sort()
        .map((key) => `${key}=${payload[key]}`)
        .join("&");
    const sign = createSign("RSA-SHA256").update(content, "utf8").sign(privateKey, "base64");
    sendJson(response, 200, { ...payload, sign_type: "RSA", sign });
}

// 用请求携带的公钥验证商户签名，确保测试能真正证明签名串与发送内容一致。
function verifyDulupayRequest(body, options) {
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    const sign = params.sign;
    if (!sign) throw new Error("Dulupay fixture request is missing sign");
    if (!options.dulupayPublicKey) throw new Error("Dulupay fixture public key is required to verify requests");
    const content = Object.keys(params)
        .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    const valid = createVerify("RSA-SHA256").update(content, "utf8").verify(options.dulupayPublicKey, sign, "base64");
    if (!valid) throw new Error("Dulupay fixture request signature is invalid");
    return params;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
    const port = Number(process.env.VOZEB_PRO_PAYMENT_FIXTURE_PORT) || 4020;
    const host = process.env.VOZEB_PRO_PAYMENT_FIXTURE_HOST || "127.0.0.1";
    const fixture = createPaymentFixtureServer({
        alipayPrivateKey: process.env.VOZEB_PRO_PAYMENT_FIXTURE_ALIPAY_PRIVATE_KEY,
        dulupayPublicKey: process.env.VOZEB_PRO_PAYMENT_FIXTURE_DULUPAY_PUBLIC_KEY,
    });
    fixture.server.listen(port, host, () => console.log(`Payment fixture ready at http://${host}:${port}`));
}
