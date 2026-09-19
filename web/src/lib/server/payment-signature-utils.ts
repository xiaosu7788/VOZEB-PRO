import { createSign, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { BillingInputError } from "@/lib/server/billing-errors";
import { getPaymentRuntimeEnv, type PaymentRuntimeConfig } from "@/lib/server/payment-config-store";

export function verifyRsaSha256(content: string, signature: string, publicKey: string) {
    try {
        return createVerify("RSA-SHA256").update(content, "utf8").verify(publicKey, signature, "base64");
    } catch {
        return false;
    }
}

export function buildRsaSignatureContent(params: Record<string, unknown>, excludedKeys: string[] = ["sign", "sign_type"]) {
    return Object.keys(params)
        .filter((key) => !excludedKeys.includes(key) && params[key] !== "" && params[key] !== undefined && params[key] !== null)
        .sort()
        .map((key) => `${key}=${String(params[key])}`)
        .join("&");
}

export function loadPaymentPublicKey(paymentConfig: PaymentRuntimeConfig, valueEnv: string, pathEnv: string, certificateEnv?: string, certificatePathEnv?: string) {
    const direct = getPaymentRuntimeEnv(paymentConfig, valueEnv) || (certificateEnv ? getPaymentRuntimeEnv(paymentConfig, certificateEnv) : "");
    if (direct) return normalizePublicKey(direct, valueEnv);
    const path = getPaymentRuntimeEnv(paymentConfig, pathEnv) || (certificatePathEnv ? getPaymentRuntimeEnv(paymentConfig, certificatePathEnv) : "");
    if (path) return normalizePublicKey(readFileSync(path, "utf8"), valueEnv);
    throw new BillingInputError(`缺少支付公钥配置：${valueEnv}`, 500);
}

function normalizePublicKey(value: string, envName: string) {
    const text = value.replace(/\\n/g, "\n").trim();
    if (text.includes("-----BEGIN")) return text;
    const body = text.replace(/[\s\r\n]+/g, "");
    if (!body) throw new BillingInputError(`支付公钥配置为空：${envName}`, 500);
    // 与私钥同理：裸正文可能是 SPKI（PUBLIC KEY）或 PKCS#1（RSA PUBLIC KEY），
    // 不能一律套 SPKI，否则 PKCS#1 公钥验签会整体失败。
    const wrapped = wrapPemBody(body, "PUBLIC KEY");
    const wrappedRsa = wrapPemBody(body, "RSA PUBLIC KEY");
    return canVerifyWith(wrapped) ? wrapped : canVerifyWith(wrappedRsa) ? wrappedRsa : wrapped;
}

export function loadPaymentPrivateKey(paymentConfig: PaymentRuntimeConfig, valueEnv: string, pathEnv: string) {
    const value = getPaymentRuntimeEnv(paymentConfig, valueEnv);
    if (value) return normalizePrivateKey(value, valueEnv);
    const path = getPaymentRuntimeEnv(paymentConfig, pathEnv);
    if (path) return normalizePrivateKey(readFileSync(path, "utf8"), valueEnv);
    throw new BillingInputError(`缺少支付私钥配置：${valueEnv}`, 500);
}

// 商户后台常常只提供 base64 正文，也可能给出 PKCS#1（RSA PRIVATE KEY）或 PKCS#8（PRIVATE KEY）两种封装。
// 没有头尾时不能一律套 PKCS#8，否则 PKCS#1 密钥会被解成错误结构，报 DECODER routines::unsupported。
function normalizePrivateKey(value: string, envName: string) {
    const text = value.replace(/\\n/g, "\n").trim();
    if (text.includes("-----BEGIN")) return text;
    const body = text.replace(/[\s\r\n]+/g, "");
    if (!body) throw new BillingInputError(`支付私钥配置为空：${envName}`, 500);
    const wrapped = wrapPemBody(body, "PRIVATE KEY");
    const wrappedRsa = wrapPemBody(body, "RSA PRIVATE KEY");
    return canSignWith(wrapped) ? wrapped : canSignWith(wrappedRsa) ? wrappedRsa : wrapped;
}

function wrapPemBody(body: string, label: string) {
    return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join("\n") || body}\n-----END ${label}-----`;
}

function canSignWith(key: string) {
    try {
        createSign("RSA-SHA256").update("").sign(key, "base64");
        return true;
    } catch {
        return false;
    }
}

function canVerifyWith(key: string) {
    try {
        // 空签名必然验证失败，但密钥结构非法时会先抛 ASN1/DECODER 错误。
        // 因此只要没有抛出结构错误，就说明这段 PEM 是可解析的公钥。
        createVerify("RSA-SHA256").update("").verify(key, "", "base64");
        return true;
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code || "") : "";
        return code === "ERR_OSSL_RSA_BAD_SIGNATURE";
    }
}
