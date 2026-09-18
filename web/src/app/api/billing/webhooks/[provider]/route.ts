import { NextResponse } from "next/server";

import { BillingInputError, isBillingInputError } from "@/lib/server/billing-service";
import { processPaymentWebhook } from "@/lib/server/payment-webhook-service";
import { normalizeProvider } from "@/lib/server/payment-webhook-adapters";
import { readRequestBodyText, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ provider: string }>;
};
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export async function POST(request: Request, context: RouteContext) {
    try {
        const { provider } = await context.params;
        const result = await processPaymentWebhook({
            provider,
            rawBody: await readRequestBodyText(request, MAX_WEBHOOK_BODY_BYTES),
            headers: request.headers,
        });
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: error.status });
        if (isBillingInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof BillingInputError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Payment webhook failed", error);
        return NextResponse.json({ error: "支付回调处理失败" }, { status: 500 });
    }
}

export async function GET(request: Request, context: RouteContext) {
    try {
        const { provider } = await context.params;
        if (normalizeProvider(provider) !== "dulupay") return NextResponse.json({ error: "该支付渠道不支持 GET 回调" }, { status: 405 });
        const result = await processPaymentWebhook({
            provider,
            rawBody: new URL(request.url).searchParams.toString(),
            headers: request.headers,
        });
        const settled = result.duplicate === true || result.orderStatus !== undefined;
        return new NextResponse(settled ? "success" : "fail", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    } catch (error) {
        if (isBillingInputError(error)) return new NextResponse("fail", { status: error.status, headers: { "content-type": "text/plain; charset=utf-8" } });
        if (error instanceof BillingInputError) return new NextResponse("fail", { status: error.status, headers: { "content-type": "text/plain; charset=utf-8" } });
        console.error("Payment webhook GET failed", error);
        return new NextResponse("fail", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
}
