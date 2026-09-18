import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ processPaymentWebhook: vi.fn() }));

vi.mock("@/lib/server/payment-webhook-service", () => ({ processPaymentWebhook: mocks.processPaymentWebhook }));

import { GET } from "./route";

describe("payment webhook GET route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.processPaymentWebhook.mockResolvedValue({ received: true, provider: "dulupay", eventId: "event-one", eventType: "dulupay.alipay", orderNo: "VZ001", orderStatus: "paid" });
    });

    it("accepts the Dulupay GET notify callback and answers plain-text success once the order is settled", async () => {
        const request = new Request("http://localhost/api/billing/webhooks/dulupay?pid=1001&out_trade_no=VZ001&trade_status=TRADE_SUCCESS");
        const response = await GET(request, { params: Promise.resolve({ provider: "dulupay" }) });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("success");
        expect(mocks.processPaymentWebhook).toHaveBeenCalledWith(expect.objectContaining({ provider: "dulupay", rawBody: "pid=1001&out_trade_no=VZ001&trade_status=TRADE_SUCCESS" }));
    });

    it("answers success for an already processed duplicate callback", async () => {
        mocks.processPaymentWebhook.mockResolvedValue({ received: true, provider: "dulupay", eventId: "event-one", eventType: "dulupay.alipay", duplicate: true, orderNo: "VZ001" });
        const response = await GET(new Request("http://localhost/api/billing/webhooks/dulupay?pid=1001"), { params: Promise.resolve({ provider: "dulupay" }) });

        expect(await response.text()).toBe("success");
    });

    it("answers fail for pending, processing and ignored callbacks so the provider retries", async () => {
        for (const result of [{ pendingVerification: true }, { processing: true }, { ignored: true }]) {
            mocks.processPaymentWebhook.mockResolvedValue({ received: true, provider: "dulupay", eventId: "event-one", eventType: "dulupay.alipay", orderNo: "VZ001", ...result });
            const response = await GET(new Request("http://localhost/api/billing/webhooks/dulupay?pid=1001"), { params: Promise.resolve({ provider: "dulupay" }) });

            expect(await response.text()).toBe("fail");
        }
    });

    it("rejects GET callbacks from providers that do not use query notifications", async () => {
        const response = await GET(new Request("http://localhost/api/billing/webhooks/stripe"), { params: Promise.resolve({ provider: "stripe" }) });

        expect(response.status).toBe(405);
        expect(mocks.processPaymentWebhook).not.toHaveBeenCalled();
    });
});
